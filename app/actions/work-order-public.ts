'use server'

import { requireOrgMember }    from '@/lib/auth'
import { inngest }             from '@/lib/inngest/client'
import { revalidatePath }      from 'next/cache'
import { renderSmsBody }       from '@/lib/sms/templates'
import { getManualUrlForAsset } from '@/lib/assets/manual-lookup'
import { unwrapJoin }          from '@/lib/utils/supabase-joins'

import { reportError } from '@/lib/observability/report-error'
import { tryUnwrap, unwrap } from '@/lib/supabase/unwrap'
import { checkLimit, emailSendActionLimiter } from '@/lib/rate-limit'
import {
  isVendorHardBlocked,
  VendorComplianceCheckError,
  VENDOR_HARD_BLOCKED_ERROR,
  VENDOR_COMPLIANCE_UNVERIFIABLE_ERROR,
} from '@/lib/vendors/compliance'
const TOKEN_TTL_DAYS = 30
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.com'

/**
 * The dispatch token written to `work_orders.completion_token`.
 *
 * MUST be a UUID. That column is `uuid` in the live schema, and the previous
 * implementation returned `randomBytes(32).toString('hex')` — 64 characters,
 * which Postgres rejects with `22P02: invalid input syntax for type uuid`.
 * An UPDATE is atomic, so the whole statement failed and every dispatch
 * returned "Failed to generate work order link". Production bears this out:
 * every completion_token in the table is a 36-char UUID (the column default,
 * or crypto.randomUUID() from the four other writers) — not one 64-char value
 * was ever stored.
 *
 * It survived 15 green unit tests because they mock the Supabase client, and
 * a mocked database cannot fail a cast.
 */
function generatePublicToken(): string {
  return crypto.randomUUID()
}

type DispatchVendor = { id: string; name: string; email: string; phone: string | null }

/** Derives a usable vendor name from an email when the PM typed no name. */
function vendorNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email
  const words = local.replace(/[._-]+/g, ' ').trim()
  return words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : email
}

/**
 * Resolves the vendor a dispatch will be sent to, CREATING one if the PM typed
 * an address that is not in the address book.
 *
 * The recipient is never taken from the request body in the sense that matters
 * — the contact details sent to are always the ones on the vendor ROW, either
 * the row that already existed or the row we just wrote from this input. What
 * changed is that an unknown address is no longer a dead end: the dispatch
 * dialog has always offered a free-text box "for a one-off contractor", and
 * that contractor now becomes a real vendor, which is what makes the rest of
 * the flow reachable for them — work_orders.vendor_id can point at them, and
 * the `work-order/dispatched` handler can send them a Stripe Connect invite so
 * they can actually be paid.
 *
 * Returns `created` so the caller can tell the PM a vendor was added rather
 * than leaving it to be discovered in the vendor list later.
 */
async function resolveOrCreateDispatchVendor(
  supabase: Awaited<ReturnType<typeof requireOrgMember>>['supabase'],
  orgId:    string,
  rawEmail: string,
  rawName:  string,
): Promise<{ vendor: DispatchVendor; created: boolean } | { error: string }> {
  // `%` and `_` are ILIKE wildcards. Unescaped, this was two bugs at once: a
  // vendorEmail of '%' matched EVERY vendor in the org and .limit(1) then
  // picked an arbitrary one to dispatch to; and a perfectly ordinary address
  // like first_last@example.com matched firstXlast@example.com as well as
  // itself (confirmed against Postgres: the unescaped pattern matches both,
  // the escaped one matches only the real address).
  const wantedEmail  = rawEmail.trim()
  const escapedEmail = wantedEmail.replace(/[\\%_]/g, (ch) => `\\${ch}`)

  if (!wantedEmail || !wantedEmail.includes('@')) {
    return { error: 'Enter a valid vendor email address.' }
  }

  const vendorRes = await supabase
    .from('vendors')
    .select('id, name, email, phone')
    .eq('org_id', orgId)
    .ilike('email', escapedEmail)
    .limit(1)
    .maybeSingle()

  const vendorOut = tryUnwrap<{ id: string; name: string; email: string | null; phone: string | null }>(
    vendorRes, { site: 'serverAction.work-order-public.dispatchWorkOrderToVendor.vendor', orgId },
  )
  if (!vendorOut.ok) return { error: 'Could not verify the vendor. Please try again.' }

  // Belt and braces on the escaping above. This action decides who receives an
  // email and an SMS, so the match must be an equality — not "whatever pattern
  // matching returned first". If the escape were ever to stop reaching
  // Postgres intact, the failure lands here as a MISS (and therefore a new
  // vendor keyed on the address actually typed) rather than as a message sent
  // to a vendor the PM never chose.
  const existing = vendorOut.data
  if (existing?.email && existing.email.toLowerCase() === wantedEmail.toLowerCase()) {
    return {
      created: false,
      vendor: { id: existing.id, name: existing.name, email: existing.email, phone: existing.phone },
    }
  }

  // Not on file — add them. upsert on the (org_id, lower(email)) unique index
  // rather than insert: a double-click or a retry after a slow response would
  // otherwise create a second vendor row for the same contractor, and each row
  // carries its own stripe_connect_token, so each would earn its own Stripe
  // Connect account and its own onboarding email.
  const createdRes = await supabase
    .from('vendors')
    .upsert(
      {
        org_id:    orgId,
        name:      rawName.trim() || vendorNameFromEmail(wantedEmail),
        email:     wantedEmail,
        is_active: true,
      },
      { onConflict: 'org_id,email', ignoreDuplicates: false },
    )
    .select('id, name, email, phone')
    .maybeSingle()

  const createdOut = tryUnwrap<{ id: string; name: string; email: string | null; phone: string | null }>(
    createdRes, { site: 'serverAction.work-order-public.dispatchWorkOrderToVendor.createVendor', orgId },
  )
  if (!createdOut.ok || !createdOut.data?.email) {
    return { error: 'Could not add that vendor. Please add them under Vendors and try again.' }
  }

  return {
    created: true,
    vendor: {
      id:    createdOut.data.id,
      name:  createdOut.data.name,
      email: createdOut.data.email,
      phone: createdOut.data.phone,
    },
  }
}


/**
 * The compliance refusal message for a vendor about to be assigned, or null.
 *
 * Dispatch ASSIGNS now, so it has to pass the same gate every other assignment
 * path does — bulkAssignVendor, acceptVendorSuggestion, createWorkOrder.
 * Without it, "Send to Vendor" would be the one route that puts a hard-blocked
 * vendor on a work order, and it is the route a PM in a hurry reaches for. A
 * vendor with NO documents on file is deliberately not blocked (see
 * NON_BLOCKING_COMPLIANCE_STATUSES), so a just-created one-off contractor
 * passes; isVendorHardBlocked fails CLOSED on a read error, which must block
 * rather than fall through to the generic catch as a pass.
 */
async function vendorComplianceRefusal(
  supabase: Awaited<ReturnType<typeof requireOrgMember>>['supabase'],
  vendorId: string,
  orgId:    string,
): Promise<string | null> {
  try {
    return await isVendorHardBlocked(supabase, vendorId, orgId)
      ? VENDOR_HARD_BLOCKED_ERROR
      : null
  } catch (err) {
    if (err instanceof VendorComplianceCheckError) return VENDOR_COMPLIANCE_UNVERIFIABLE_ERROR
    throw err
  }
}

/**
 * Texts the vendor alongside the dispatch email, when they have a mobile on
 * file. Non-fatal by design: the work order is assigned and the email is
 * already sent by the time this runs, so an SMS failure must not undo either.
 */
async function sendDispatchSms(params: {
  vendorPhone: string | null
  vendorName:  string
  orgId:       string
  token:       string
  woNumber:    string
  nteAmount:   number
  propName:    string
  pmName:      string
  orgName:     string
}): Promise<void> {
  if (!params.vendorPhone) return

  const { normalizePhoneToE164, sendSMS } = await import('@/lib/sms/telnyx')
  const e164 = normalizePhoneToE164(params.vendorPhone)
  if (!e164) return

  const nteLine = params.nteAmount > 0 ? `\nNTE: $${params.nteAmount.toLocaleString()}` : ''

  try {
    const smsBody = await renderSmsBody(params.orgId, 'vendor_work_order', {
      vendor_name:   params.vendorName,
      wo_number:     params.woNumber,
      property_name: params.propName,
      pm_name:       params.pmName,
      org_name:      params.orgName,
      nte_amount:    params.nteAmount,
      window:        null,    // manual dispatch has no scheduled window
      nte_line:      nteLine,
      window_line:   '',
      portal_url:    `${APP_URL}/work-orders/${params.token}`,
    })
    await sendSMS(e164, smsBody, { orgId: params.orgId })
  } catch (smsErr) {
    console.error('[dispatchWorkOrderToVendor] SMS failed (non-fatal):', smsErr)
    reportError(smsErr, { site: 'serverAction.work-order-public.dispatchWorkOrderToVendor' })
  }
}

export async function dispatchWorkOrderToVendor(input: {
  workOrderId:  string
  vendorEmail:  string
  vendorName:   string
  vendorPhone?: string | null
}): Promise<{
  success?:       boolean
  token?:         string
  publicUrl?:     string
  /** True when the typed address was not on file and a vendor row was added. */
  vendorCreated?: boolean
  vendorName?:    string
  error?:         string
}> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    // This action sends an email AND an SMS to addresses that arrive in the
    // request body. Without a limiter, one authenticated trial user could loop
    // it over attacker-chosen recipients — bounded only by Vercel concurrency
    // — and relay from our sending domain and our Telnyx number. Resend's
    // idempotency key includes the recipient, so varying it defeats that too.
    // Keyed per user: the org is not the thing being abused.
    const limit = await checkLimit(emailSendActionLimiter, user.id, {
      onError: 'allow',   // abuse limiter, not a spend ceiling — see lib/rate-limit.ts
      site:    'serverAction.work-order-public.dispatchWorkOrderToVendor',
    })
    if (!limit.allowed) {
      return { error: 'Too many vendor dispatches in the last hour. Please try again shortly.' }
    }

    const { data: wo, error: fetchErr } = await supabase
      .from('work_orders')
      .select(`
        id, wo_number, status, org_id, property_id, asset_id, title,
        description, nte_amount, access_notes, lockbox_code, parking_notes,
        properties ( name, address ),
        vendors ( name, email )
      `)
      .eq('id', input.workOrderId)
      .eq('org_id', membership.org_id)
      .single()

    if (fetchErr || !wo) return { error: 'Work order not found' }

    if (wo.status === 'cancelled') {
      return { error: 'This work order has been cancelled' }
    }

    // The recipient is NEVER relayed from the request body. `vendorEmail` and
    // `vendorPhone` used to go verbatim to Resend and Telnyx, which made this
    // action a general-purpose email/SMS relay for anyone with a trial account
    // — and the Resend idempotency key contains the recipient, so looping over
    // addresses defeated that too. The contact details sent to are always the
    // ones on a vendor ROW in the caller's own org, either one that already
    // existed or one written from this input.
    const resolved = await resolveOrCreateDispatchVendor(
      supabase, membership.org_id, input.vendorEmail, input.vendorName ?? '',
    )
    if ('error' in resolved) return { error: resolved.error }

    const { email: vendorEmail, name: vendorName, phone: vendorPhone } = resolved.vendor
    const vendorId = resolved.vendor.id

    const blocked = await vendorComplianceRefusal(supabase, vendorId, membership.org_id)
    if (blocked) return { error: blocked }

    const token     = generatePublicToken()
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + TOKEN_TTL_DAYS)

    const { error: updateErr } = await supabase
      .from('work_orders')
      .update({
        // THE ASSIGNMENT. Dispatch used to write only the token and the
        // dispatch email, so a work order whose vendor had already been sent a
        // portal link — and could complete it — still read `pending` with
        // vendor_id NULL. Everything keyed on vendor_id missed it: the daily
        // wrap-up's unassigned sweep, the digest's stillUnassigned check,
        // vendor scoring, the work order's own vendor panel, and — because
        // work-order-dispatch.ts bails on `if (!wo?.vendor_id)` — the Stripe
        // Connect invite, so the vendor could never be paid either.
        vendor_id:                   vendorId,
        completion_token:            token,
        completion_token_expires_at: expiresAt.toISOString(),
        vendor_dispatch_email:       vendorEmail,
        // The portal page this link points at filters on
        // .eq('portal_enabled', true) (app/work-orders/[token]/page.tsx:38).
        // Dispatching a work order created with the portal off — which is the
        // default whenever request_quotes was set, see maintenance/actions.ts
        // `usePortal` — minted a valid token behind a notFound(). The Inngest
        // dispatch path already sets this for the same reason
        // (work-order-vendor-assigned.ts:99).
        portal_enabled:              true,
      })
      .eq('id', input.workOrderId)
      // Defence in depth. The row was already org-scoped on the read above and
      // this client is RLS-enforced, but a write reachable from a request body
      // should not depend on a check made ninety lines earlier.
      .eq('org_id', membership.org_id)

    if (updateErr) {
      console.error('[dispatchWorkOrderToVendor] update token', updateErr)
      return { error: 'Failed to generate work order link' }
    }

    // Advance the status too, in a SECOND filtered statement: the assignment
    // above must land on the row unconditionally, but the status must only
    // move FORWARD — re-dispatching an in_progress work order must not drag it
    // back to `assigned`. Same shape as bulkAssignVendor.
    //
    // Reported, not returned: the vendor is assigned and the email is already
    // on its way by the time this runs.
    const { error: statusErr } = await supabase
      .from('work_orders')
      .update({ status: 'assigned' })
      .eq('id', input.workOrderId)
      .eq('org_id', membership.org_id)
      .in('status', ['pending', 'quote_requested'])

    if (statusErr) {
      console.error('[dispatchWorkOrderToVendor] status advance', statusErr)
      reportError(statusErr, {
        site:  'serverAction.work-order-public.dispatchWorkOrderToVendor.status',
        orgId: membership.org_id,
      })
    }

    const profileRes = await supabase
      .from('profiles')
      .select('full_name, phone')
      .eq('id', user.id)
      .single()
    const profile = unwrap(profileRes, {
      site:  'serverAction.work-order-public.dispatchWorkOrderToVendor.profile',
      orgId: membership.org_id,
    })

    const orgRes = await supabase
      .from('organizations')
      .select('name')
      .eq('id', membership.org_id)
      .single()
    const org = unwrap(orgRes, {
      site:  'serverAction.work-order-public.dispatchWorkOrderToVendor.org',
      orgId: membership.org_id,
    })

    const property = unwrapJoin(wo.properties)

    const manualUrl = await getManualUrlForAsset(supabase, membership.org_id, wo.asset_id ?? null)

    await inngest.send({
      name: 'work-order/dispatched' as const,
      data: {
        workOrderId:      wo.id,
        woNumber:         wo.wo_number ?? '',
        token,
        publicUrl:        `${APP_URL}/work-orders/${token}`,
        vendorEmail:      vendorEmail,
        vendorName:       vendorName,
        propertyName:     (property as { name: string } | null)?.name  ?? 'Property',
        propertyAddress:  (property as { address: string | null } | null)?.address ?? '',
        title:            wo.title,
        description:      wo.description ?? '',
        nteAmount:        (wo.nte_amount as number | null) ?? 0,
        dispatcherName:   profile?.full_name ?? 'Your Property Manager',
        dispatcherOrg:    org?.name ?? 'FieldStay Property Management',
        dispatcherPhone:  profile?.phone ?? null,
        manualUrl,
      },
    })

    await sendDispatchSms({
      vendorPhone, vendorName, orgId: membership.org_id, token,
      woNumber:  wo.wo_number ?? '',
      nteAmount: (wo.nte_amount as number | null) ?? 0,
      propName:  (property as { name: string } | null)?.name ?? 'Property',
      pmName:    profile?.full_name ?? 'Your Property Manager',
      orgName:   org?.name ?? 'FieldStay Property Management',
    })

    revalidatePath('/maintenance')
    return {
      success:      true,
      token,
      publicUrl:    `${APP_URL}/work-orders/${token}`,
      vendorCreated: resolved.created,
      vendorName,
    }

  } catch (err) {
    console.error('[dispatchWorkOrderToVendor]', err)
    reportError(err, { site: 'serverAction.work-order-public.dispatchWorkOrderToVendor' })
    return { error: 'Operation failed. Please try again.' }
  }
}
