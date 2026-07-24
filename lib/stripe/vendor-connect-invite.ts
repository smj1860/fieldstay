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
async function claimVendorConnectInvite(
  supabase: ServiceClient,
  vendorId: string,
  orgId: string
): Promise<{
  claimed:     boolean
  accountId:   string | null
  alreadySent: boolean
}> {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_AFTER_MS).toISOString()

  const { data: claimed } = await supabase
    .from('vendors')
    .update({ stripe_connect_invite_claimed_at: new Date().toISOString() })
    .eq('id', vendorId)
    .eq('org_id', orgId)
    .or(`stripe_connect_invite_claimed_at.is.null,stripe_connect_invite_claimed_at.lt.${staleBefore}`)
    .select('stripe_connect_account_id, stripe_connect_invite_sent_at')
    .maybeSingle()

  if (!claimed) return { claimed: false, accountId: null, alreadySent: false }

  return {
    claimed:     true,
    accountId:   claimed.stripe_connect_account_id,
    alreadySent: !!claimed.stripe_connect_invite_sent_at,
  }
}

async function releaseVendorConnectInviteClaim(
  supabase: ServiceClient,
  vendorId: string,
  orgId: string
): Promise<void> {
  await supabase
    .from('vendors')
    .update({ stripe_connect_invite_claimed_at: null })
    .eq('id', vendorId)
    .eq('org_id', orgId)
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

    let accountId = claim.accountId

    if (!accountId) {
      const account = await stripe.accounts.create({
        type:  'express',
        email: params.vendorEmail,
        metadata: {
          vendor_id: params.vendorId,
          org_id:    params.orgId,
        },
        capabilities: {
          card_payments: { requested: true },
          transfers:     { requested: true },
        },
      })
      accountId = account.id

      // Persisted immediately — independent of whether the email send below
      // succeeds — so a retry after a Resend failure reuses this account
      // instead of creating a second, untracked one.
      await supabase
        .from('vendors')
        .update({ stripe_connect_account_id: accountId })
        .eq('id', params.vendorId)
        .eq('org_id', params.orgId)
    }

    const onboardingUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/vendor-connect/${params.vendorConnectToken}/onboard`

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
    })

    await supabase
      .from('vendors')
      .update({ stripe_connect_invite_sent_at: new Date().toISOString() })
      .eq('id', params.vendorId)
      .eq('org_id', params.orgId)

    return { invited: true }
  } finally {
    await releaseVendorConnectInviteClaim(supabase, params.vendorId, params.orgId)
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
    let accountId = claim.accountId

    if (!accountId) {
      const account = await stripe.accounts.create({
        type:  'express',
        email: params.vendorEmail,
        metadata: {
          vendor_id: params.vendorId,
          org_id:    params.orgId,
        },
        capabilities: {
          card_payments: { requested: true },
          transfers:     { requested: true },
        },
      })
      accountId = account.id
    }

    const onboardingUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/vendor-connect/${params.vendorConnectToken}/onboard`

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
    })

    await supabase
      .from('vendors')
      .update({
        stripe_connect_account_id:     accountId,
        stripe_connect_invite_sent_at: new Date().toISOString(),
      })
      .eq('id', params.vendorId)
      .eq('org_id', params.orgId)
  } finally {
    await releaseVendorConnectInviteClaim(supabase, params.vendorId, params.orgId)
  }
}
