import { unwrap, reportQueryError } from '@/lib/supabase/unwrap'
import { stripe }              from '@/lib/stripe/client'
import { resend, FROM }        from '@/lib/resend/client'
import { createServiceClient } from '@/lib/supabase/server'
import { renderVendorConnectInviteEmail } from '@/lib/resend/emails/vendor-connect-invite'

type ServiceClient = ReturnType<typeof createServiceClient>

// How long a claim is honored before it's treated as abandoned (a crashed
// process that never reached the `finally` release) and reclaimable by a
// later attempt. Comfortably longer than a Stripe API call + email send.
const CLAIM_STALE_AFTER_MS = 2 * 60 * 1000

/**
 * Atomically claims a vendor row for a Connect-invite attempt, closing the
 * TOCTOU race across ensureVendorConnectInvited()'s callers (nightly cron,
 * work order dispatch) and resendVendorConnectInvite() (the PM "Resend"
 * button) — all three previously did a read-then-act with nothing
 * preventing two from acting on the same vendor at once.
 *
 * The UPDATE's WHERE clause only matches (and therefore only returns a row)
 * if no other attempt currently holds the claim — Postgres guarantees that
 * of two concurrent UPDATEs racing on the same row, only one actually
 * applies and returns data; the other affects zero rows. That's the whole
 * lock: no advisory lock or explicit transaction needed.
 */
type VendorConnectClaim =
  | { claimed: false }
  | {
      claimed: true
      claimedAt: string
      accountId: string | null
      /**
       * Non-null with a null accountId means a previous attempt reached Stripe
       * and may have orphaned an Express account. See GitHub #573.
       */
      accountPendingAt: string | null
      alreadySent: boolean
      /** Durable delivery reference from a previous attempt, if one exists. */
      deliveryRef: string | null
    }

async function claimVendorConnectInvite(
  supabase: ServiceClient,
  vendorId: string,
  orgId: string
): Promise<VendorConnectClaim> {
  const now = new Date().toISOString()
  const staleBefore = new Date(Date.now() - CLAIM_STALE_AFTER_MS).toISOString()

  // A failed claim returned { claimed: false }, identical to "another run got
  // there first" — so the vendor's Connect invite was silently never sent.
  const claimedRes = await supabase
    .from('vendors')
    .update({ stripe_connect_invite_claimed_at: now })
    .eq('id', vendorId)
    .eq('org_id', orgId)
    .or(`stripe_connect_invite_claimed_at.is.null,stripe_connect_invite_claimed_at.lt.${staleBefore}`)
    .select('stripe_connect_account_id, stripe_connect_account_pending_at, stripe_connect_invite_sent_at, stripe_connect_invite_delivery_ref')
    .maybeSingle()

  const claimed = unwrap(claimedRes, { site: 'lib.stripe.vendor-connect-invite.claim', orgId })

  if (!claimed) return { claimed: false }

  return {
    claimed:     true,
    claimedAt:   now,
    accountId:        claimed.stripe_connect_account_id,
    accountPendingAt: claimed.stripe_connect_account_pending_at,
    alreadySent:      !!claimed.stripe_connect_invite_sent_at,
    deliveryRef: claimed.stripe_connect_invite_delivery_ref,
  }
}

/**
 * Releases the claim this attempt holds — and ONLY the claim this attempt
 * holds. Fenced on the exact claimedAt timestamp claimVendorConnectInvite()
 * returned: without it, an attempt that runs past CLAIM_STALE_AFTER_MS (slow
 * Stripe API, slow email send) would clear whatever claim is on the row by
 * the time its `finally` runs — which, once the claim has gone stale, may
 * belong to a second attempt that reclaimed it and is still in flight. That
 * second attempt's claim would be released out from under it, letting a
 * third attempt claim the same vendor while the second is still working.
 */
async function releaseVendorConnectInviteClaim(
  supabase: ServiceClient,
  vendorId: string,
  orgId: string,
  claimedAt: string
): Promise<void> {
  const { error } = await supabase
    .from('vendors')
    .update({ stripe_connect_invite_claimed_at: null })
    .eq('id', vendorId)
    .eq('org_id', orgId)
    .eq('stripe_connect_invite_claimed_at', claimedAt)

  // Non-fatal by design — CLAIM_STALE_AFTER_MS reclaims an unreleased claim
  // on its own — but a release that silently never happens should still be
  // visible rather than only inferred from a stalled vendor two minutes later.
  reportQueryError(error, { site: 'lib.stripe.vendor-connect-invite.release', orgId })
}

/**
 * Returns the vendor's existing Stripe Express account id, or creates one and
 * persists it immediately — independent of whether the email send that
 * follows succeeds — so a retry after a Resend failure reuses this account
 * instead of creating (and orphaning) a second one. Shared by
 * ensureVendorConnectInvited() and resendVendorConnectInvite(), which were
 * previously two copies of the same create-then-persist block.
 *
 * A failed persist throws (via unwrap) rather than returning the unsaved id:
 * the caller must not proceed to send an invite for an account id the DB
 * doesn't have.
 */
async function getOrCreateVendorStripeAccount(
  supabase: ServiceClient,
  claim: { accountId: string | null; accountPendingAt: string | null },
  params: { vendorId: string; orgId: string; vendorEmail: string },
  site: string
): Promise<string> {
  if (claim.accountId) return claim.accountId

  // A previous attempt got as far as Stripe and did not finish persisting.
  // Look for what it may have left behind before making another one.
  if (claim.accountPendingAt) {
    const orphan = await findOrphanedVendorAccount(params.vendorId)
    if (orphan) {
      await persistVendorStripeAccount(supabase, orphan, params, site)
      return orphan
    }
  }

  // WRITTEN BEFORE THE STRIPE CALL, and that ordering is the whole mechanism.
  // If this write fails we have not created anything yet; if the call after it
  // fails we have a durable record that it might have succeeded.
  const markRes = await supabase
    .from('vendors')
    .update({ stripe_connect_account_pending_at: new Date().toISOString() })
    .eq('id', params.vendorId)
    .eq('org_id', params.orgId)
    .select('id')
    .maybeSingle()

  if (!unwrap(markRes, { site, orgId: params.orgId })) {
    throw new Error(
      `Vendor ${params.vendorId} matched zero rows while marking a Stripe account creation as pending — refusing to create an account we could not record the intent for.`
    )
  }

  const account = await createVendorStripeAccount(params)
  await persistVendorStripeAccount(supabase, account, params, site)
  return account
}

/**
 * Creates the Express account, keyed so a retry inside Stripe's window
 * replays rather than duplicates.
 *
 * The key is derived from the VENDOR, not from the attempt: two attempts for
 * one vendor must collide, which is the entire point. Stripe retains
 * idempotency keys for 24 HOURS — a retry inside that window returns the
 * original account object, one outside it would create a duplicate. That
 * remaining window is what stripe_connect_account_pending_at covers, so the
 * two mechanisms are complementary rather than redundant: the key handles the
 * common transient retry cheaply, the marker handles everything slower.
 *
 * A same-key-different-parameters call is an error at Stripe, not a silent
 * duplicate — it happens when the vendor's email is edited between attempts.
 * Reconciling is the correct response: the account that already exists is the
 * one we want, whatever address it was opened with.
 */
async function createVendorStripeAccount(
  params: { vendorId: string; orgId: string; vendorEmail: string }
): Promise<string> {
  try {
    const account = await stripe.accounts.create({
      type:  'express',
      email: params.vendorEmail,
      metadata: {
        // The only handle reconciliation has. accounts.list offers no metadata
        // filter and Stripe's Search API does not cover Connect accounts, so
        // an account created without this is unfindable.
        vendor_id: params.vendorId,
        org_id:    params.orgId,
      },
      capabilities: {
        card_payments: { requested: true },
        transfers:     { requested: true },
      },
    }, { idempotencyKey: `fs-vendor-acct-${params.vendorId}` })

    return account.id
  } catch (err) {
    if ((err as { type?: string }).type !== 'idempotency_error') throw err

    const orphan = await findOrphanedVendorAccount(params.vendorId)
    if (orphan) return orphan

    throw new Error(
      `Stripe rejected the account-creation key for vendor ${params.vendorId} as reused with different parameters, ` +
      `but no account carrying that vendor_id could be found to reconcile against.`,
      { cause: err },
    )
  }
}

/** Persists the account id, failing loudly rather than returning it unsaved. */
async function persistVendorStripeAccount(
  supabase: ServiceClient,
  accountId: string,
  params: { vendorId: string; orgId: string },
  site: string
): Promise<void> {
  // .select().maybeSingle() rather than a bare .update(): an UPDATE that
  // matches zero rows (the vendor was deleted/reassigned after the claim)
  // resolves with { data: null, error: null } — no error at all — so a bare
  // unwrap() would read that as success and return an account id that was
  // never actually saved anywhere.
  const persistAccountRes = await supabase
    .from('vendors')
    .update({
      stripe_connect_account_id: accountId,
      // Cleared in the SAME statement that stores the id. Two statements would
      // leave a window where both are set, and a crash inside it would send
      // the next attempt down the reconciliation path for an account we had
      // already recorded — wasteful, not wrong, but avoidable for free.
      stripe_connect_account_pending_at: null,
    })
    .eq('id', params.vendorId)
    .eq('org_id', params.orgId)
    .select('id')
    .maybeSingle()

  if (!unwrap(persistAccountRes, { site, orgId: params.orgId })) {
    throw new Error(
      `Vendor ${params.vendorId} matched zero rows while persisting its Stripe Connect account ${accountId} — the account exists in Stripe but was not saved.`
    )
  }
}

/**
 * Finds an Express account this platform created for `vendorId` that our
 * database has no record of.
 *
 * Listing and filtering client-side is the only option: accounts.list takes no
 * metadata filter and Stripe's Search API does not support Connect accounts.
 * That is why this runs ONLY when stripe_connect_account_pending_at says an
 * attempt reached Stripe, never on the ordinary first invite.
 *
 * Bounded, and it THROWS rather than returning null when the bound is hit.
 * Returning null there would read as "no orphan exists" and create a second
 * account — reintroducing the exact defect this function was added to prevent,
 * in the one situation where an orphan is most likely.
 */
const ORPHAN_SCAN_MAX_PAGES = 20

async function findOrphanedVendorAccount(vendorId: string): Promise<string | null> {
  let startingAfter: string | undefined
  let pages = 0

  while (pages < ORPHAN_SCAN_MAX_PAGES) {
    pages++
    const page = await stripe.accounts.list(
      startingAfter ? { limit: 100, starting_after: startingAfter } : { limit: 100 }
    )

    const match = page.data.find((a) => a.metadata?.vendor_id === vendorId)
    if (match) return match.id

    if (!page.has_more || page.data.length === 0) return null
    startingAfter = page.data[page.data.length - 1]!.id
  }

  throw new Error(
    `Scanned ${ORPHAN_SCAN_MAX_PAGES} pages of Stripe accounts without reaching the end while reconciling vendor ${vendorId}. ` +
    `Refusing to create a new Express account — doing so risks the duplicate this scan exists to prevent.`
  )
}

/**
 * The durable reference identifying ONE invite delivery, reused across
 * attempts so a retry cannot deliver a second email.
 *
 * ── The defect this closes (GitHub #574) ────────────────────────────────────
 *
 * markVendorConnectInviteSent() is deliberately non-fatal: the email has
 * already gone out by the time it runs, so throwing would not un-send it. But
 * when that write fails, the only durable record that delivery happened is
 * lost — and the next cron tick, work-order dispatch, or PM resend sees an
 * unsent invite and emails the vendor again. The claim does not help: it is
 * released in a `finally` and goes stale after two minutes by design.
 *
 * ── Why the reference is STORED rather than derived ─────────────────────────
 *
 * Resend deduplicates on an Idempotency-Key header, but only if the retry
 * presents the SAME key. Deriving one from the vendor id would make it stable
 * forever, which would permanently break the PM's "Resend" button — whose
 * whole purpose is to deliver another email. Storing it lets the two paths
 * differ: the automatic senders reuse, the PM resend rotates.
 *
 * `reuse: false` forces a fresh reference — that is the resend path.
 */
async function claimInviteDeliveryRef(
  supabase: ServiceClient,
  vendorId: string,
  orgId: string,
  existing: string | null,
  opts: { reuse: boolean },
  site: string
): Promise<string> {
  if (opts.reuse && existing) return existing

  // crypto.randomUUID, not Math.random — this is an idempotency key, and a
  // predictable one lets an unrelated delivery collide with this vendor's.
  const ref = crypto.randomUUID()

  const res = await supabase
    .from('vendors')
    .update({ stripe_connect_invite_delivery_ref: ref })
    .eq('id', vendorId)
    .eq('org_id', orgId)
    .select('id')
    .maybeSingle()

  // Same zero-row reasoning as the account persist: an UPDATE matching nothing
  // resolves { data: null, error: null }, and sending against a reference the
  // database never stored is the exact hole this function exists to close —
  // the retry would generate a different one and deduplicate against nothing.
  const persisted = unwrap(res, { site, orgId })
  if (!persisted) {
    throw new Error(
      `Vendor ${vendorId} matched zero rows while persisting its invite delivery reference — refusing to send an invite that cannot be deduplicated on retry.`
    )
  }

  return ref
}

/**
 * Drops the stored reference after a send that THREW.
 *
 * A throw means the email was not delivered, so the next attempt must be a
 * genuinely new delivery. Keeping the reference would make that attempt
 * present a key Resend may already have seen, and the retry of a FAILED send
 * would be silently deduplicated into never being sent at all — turning a
 * transient Resend error into a permanently missing invite.
 */
async function clearInviteDeliveryRef(
  supabase: ServiceClient,
  vendorId: string,
  orgId: string,
  site: string
): Promise<void> {
  const { error } = await supabase
    .from('vendors')
    .update({ stripe_connect_invite_delivery_ref: null })
    .eq('id', vendorId)
    .eq('org_id', orgId)

  // Non-fatal: the send already failed and that error is the one worth
  // surfacing. Reported rather than swallowed, because a reference left behind
  // makes the NEXT attempt a no-op and that is invisible from the outside.
  reportQueryError(error, { site, orgId })
}

/**
 * Marks the invite as sent. The email has already gone out by the time this
 * is called, so a failure here is logged rather than thrown — losing it only
 * means the next attempt RE-RUNS, and the stored delivery reference is what
 * stops that re-run from delivering a second email.
 */
async function markVendorConnectInviteSent(
  supabase: ServiceClient,
  vendorId: string,
  orgId: string,
  site: string
): Promise<void> {
  const { error } = await supabase
    .from('vendors')
    .update({ stripe_connect_invite_sent_at: new Date().toISOString() })
    .eq('id', vendorId)
    .eq('org_id', orgId)

  reportQueryError(error, { site, orgId })
}

export interface EnsureVendorConnectInvitedParams {
  vendorId:           string
  orgId:              string
  vendorEmail:        string
  vendorName:         string | null
  vendorConnectToken: string
  orgName:            string
  pmName?:            string | null
  woNumber?:          string | null
}

/**
 * Creates a Stripe Express account and sends the Connect onboarding invite
 * email for a vendor who doesn't have one yet. Shared by the nightly
 * vendor-connect-onboarding cron and the work-order-dispatch handler
 * (CLAUDE_62_0) — both onboarding triggers need identical account-creation
 * and invite-email logic, just fired on different events.
 *
 * Claims the vendor row for the duration of the attempt (see
 * claimVendorConnectInvite above) — this is what actually prevents two
 * invites / two Stripe accounts when the cron and a dispatch fire close
 * together, not just the fresh re-read that used to be the only guard.
 */
export async function ensureVendorConnectInvited(
  params: EnsureVendorConnectInvitedParams
): Promise<{ invited: boolean }> {
  const supabase = createServiceClient({ system: 'lib/stripe/vendor-connect-invite' })

  const claim = await claimVendorConnectInvite(supabase, params.vendorId, params.orgId)
  if (!claim.claimed) {
    // Another attempt (cron, dispatch, or a PM resend) is working on this
    // vendor right now. Not an error — the cron retries next tick, and
    // dispatch only needed *an* invite sent, not necessarily this one.
    return { invited: false }
  }

  try {
    // stripe_connect_invite_sent_at is the only true "done" signal.
    // stripe_connect_account_id can be set WITHOUT it if a prior attempt
    // created the Stripe account but failed before the email send
    // completed — in that case we reuse the existing account rather than
    // creating (and orphaning) a second one.
    if (claim.alreadySent) {
      return { invited: false }
    }

    await getOrCreateVendorStripeAccount(
      supabase,
      claim,
      params,
      'lib.stripe.vendor-connect-invite.persist-account'
    )

    // REUSED, not rotated. This is the automatic path — cron and work-order
    // dispatch — so a run reaching here with a reference already stored means
    // a previous attempt sent the email and failed to record it. Presenting
    // that same key is what makes this run a no-op at Resend instead of a
    // second email to the vendor.
    const deliveryRef = await claimInviteDeliveryRef(
      supabase, params.vendorId, params.orgId, claim.deliveryRef, { reuse: true },
      'lib.stripe.vendor-connect-invite.delivery-ref'
    )

    const onboardingUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/vendor-connect/${params.vendorConnectToken}/onboard`

    try {
      await resend.emails.send({
        from:    FROM,
        to:      params.vendorEmail,
        subject: `${params.orgName} pays invoices via Stripe Connect — set up your payout account`,
        html:    await renderVendorConnectInviteEmail({
          vendorName:    params.vendorName,
          orgName:       params.orgName,
          pmName:        params.pmName ?? null,
          woNumber:      params.woNumber ?? null,
          onboardingUrl,
        }),
      }, { idempotencyKey: `vendor-connect-invite-${deliveryRef}` })
    } catch (err) {
      await clearInviteDeliveryRef(
        supabase, params.vendorId, params.orgId,
        'lib.stripe.vendor-connect-invite.clear-delivery-ref'
      )
      throw err
    }

    await markVendorConnectInviteSent(
      supabase,
      params.vendorId,
      params.orgId,
      'lib.stripe.vendor-connect-invite.mark-sent'
    )

    return { invited: true }
  } finally {
    await releaseVendorConnectInviteClaim(supabase, params.vendorId, params.orgId, claim.claimedAt)
  }
}

export interface ResendVendorConnectInviteParams {
  vendorId:           string
  orgId:              string
  vendorEmail:        string
  vendorName:         string | null
  vendorConnectToken: string
  orgName:            string
}

/**
 * PM-initiated resend from the vendor detail page — unlike
 * ensureVendorConnectInvited(), this intentionally ignores the
 * stripe_connect_invite_sent_at guard so a lost or ignored invite can be
 * re-sent on demand. Reuses the vendor's existing Stripe Express account
 * if one was already created rather than creating a second one.
 *
 * Shares the same claim as ensureVendorConnectInvited() — a PM clicking
 * "Resend" right as the cron or a dispatch is mid-attempt for the same
 * vendor now fails fast and asks the PM to retry, rather than racing it.
 * The claim's fresh account-id read also replaces what used to be a
 * caller-supplied (and potentially stale by the time this function ran)
 * existingStripeAccountId parameter — this function re-reads it itself now.
 */
export async function resendVendorConnectInvite(
  params: ResendVendorConnectInviteParams
): Promise<void> {
  const supabase = createServiceClient({ system: 'lib/stripe/vendor-connect-invite' })

  const claim = await claimVendorConnectInvite(supabase, params.vendorId, params.orgId)
  if (!claim.claimed) {
    throw new Error("This vendor's Connect invite is already being processed — try again in a moment.")
  }

  try {
    await getOrCreateVendorStripeAccount(
      supabase,
      claim,
      params,
      'lib.stripe.vendor-connect-invite.resend-persist-account'
    )

    // ROTATED, not reused — the opposite of the automatic path above. A PM
    // clicking "Resend" is asking for another email on purpose; presenting the
    // previous delivery's key would have Resend deduplicate it away and the
    // button would silently do nothing, which is the same class of defect as
    // the duplicate it is guarding against, just pointing the other way.
    const deliveryRef = await claimInviteDeliveryRef(
      supabase, params.vendorId, params.orgId, claim.deliveryRef, { reuse: false },
      'lib.stripe.vendor-connect-invite.resend-delivery-ref'
    )

    const onboardingUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/vendor-connect/${params.vendorConnectToken}/onboard`

    try {
      await resend.emails.send({
        from:    FROM,
        to:      params.vendorEmail,
        subject: `Reminder: set up your Stripe payout account for ${params.orgName}`,
        html:    await renderVendorConnectInviteEmail({
          vendorName: params.vendorName,
          orgName:    params.orgName,
          pmName:     null,
          woNumber:   null,
          onboardingUrl,
        }),
      }, { idempotencyKey: `vendor-connect-invite-${deliveryRef}` })
    } catch (err) {
      await clearInviteDeliveryRef(
        supabase, params.vendorId, params.orgId,
        'lib.stripe.vendor-connect-invite.resend-clear-delivery-ref'
      )
      throw err
    }

    await markVendorConnectInviteSent(
      supabase,
      params.vendorId,
      params.orgId,
      'lib.stripe.vendor-connect-invite.resend-mark-sent'
    )
  } finally {
    await releaseVendorConnectInviteClaim(supabase, params.vendorId, params.orgId, claim.claimedAt)
  }
}
