'use server'

import { requireOrgMember }    from '@/lib/auth'
import { inngest }             from '@/lib/inngest/client'
import { revalidatePath }      from 'next/cache'
import { renderSmsBody }       from '@/lib/sms/templates'
import { getManualUrlForAsset } from '@/lib/assets/manual-lookup'
import { unwrapJoin }          from '@/lib/utils/supabase-joins'

import { reportError } from '@/lib/observability/report-error'
import { tryUnwrap }   from '@/lib/supabase/unwrap'
import { checkLimit, emailSendActionLimiter } from '@/lib/rate-limit'
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

/**
 * Resolves the vendor a dispatch will actually be sent to, from the caller's
 * own address book.
 *
 * The recipient is NEVER taken from the request body — see the note at the
 * call site. Extracted so dispatchWorkOrderToVendor stays under the
 * cognitive-complexity threshold once the equality re-check below was added.
 */
async function resolveDispatchVendor(
  supabase: Awaited<ReturnType<typeof requireOrgMember>>['supabase'],
  orgId:    string,
  rawEmail: string,
): Promise<{ vendor: DispatchVendor } | { error: string }> {
  const notFound = 'That vendor is not in your address book, or has no email on file.'

  // `%` and `_` are ILIKE wildcards. Unescaped, this was two bugs at once: a
  // vendorEmail of '%' matched EVERY vendor in the org and .limit(1) then
  // picked an arbitrary one to dispatch to; and a perfectly ordinary address
  // like first_last@example.com matched firstXlast@example.com as well as
  // itself (confirmed against Postgres: the unescaped pattern matches both,
  // the escaped one matches only the real address).
  const wantedEmail  = rawEmail.trim()
  const escapedEmail = wantedEmail.replace(/[\\%_]/g, (ch) => `\\${ch}`)

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
  if (!vendorOut.ok)        return { error: 'Could not verify the vendor. Please try again.' }
  if (!vendorOut.data?.email) return { error: notFound }

  // Belt and braces on the escaping above. This action decides who receives an
  // email and an SMS, so the match must be an equality — not "whatever pattern
  // matching returned first". If the escape were ever to stop reaching
  // Postgres intact, the failure lands here as a refused dispatch rather than
  // as a message sent to a vendor the PM never chose.
  if (vendorOut.data.email.toLowerCase() !== wantedEmail.toLowerCase()) {
    return { error: notFound }
  }

  return {
    vendor: {
      id:    vendorOut.data.id,
      name:  vendorOut.data.name,
      email: vendorOut.data.email,
      phone: vendorOut.data.phone,
    },
  }
}

export async function dispatchWorkOrderToVendor(input: {
  workOrderId:  string
  vendorEmail:  string
  vendorName:   string
  vendorPhone?: string | null
}): Promise<{ success?: boolean; token?: string; publicUrl?: string; error?: string }> {
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

    // The recipient is NEVER taken from the request body. `vendorEmail` and
    // `vendorPhone` used to be relayed verbatim to Resend and Telnyx, which
    // made this action a general-purpose email/SMS relay for anyone with a
    // trial account — and the Resend idempotency key contains the recipient,
    // so looping over addresses defeated that too. Resolve the vendor from our
    // own records, scoped to the caller's org, and send only to the contact
    // details that row carries.
    // `%` and `_` are ILIKE wildcards. Unescaped, this was two bugs at once:
    // a vendorEmail of '%' matched EVERY vendor in the org and .limit(1) then
    // picked an arbitrary one to dispatch to; and a perfectly ordinary address
    // like first_last@example.com matched firstXlast@example.com as well as
    // itself (confirmed against Postgres: the unescaped pattern matches both,
    // the escaped one matches only the real address).
    const resolved = await resolveDispatchVendor(supabase, membership.org_id, input.vendorEmail)
    if ('error' in resolved) return { error: resolved.error }

    const { email: vendorEmail, name: vendorName, phone: vendorPhone } = resolved.vendor

    const token     = generatePublicToken()
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + TOKEN_TTL_DAYS)

    const { error: updateErr } = await supabase
      .from('work_orders')
      .update({
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

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, phone')
      .eq('id', user.id)
      .single()

    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', membership.org_id)
      .single()

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

    // SMS — send alongside the dispatched email when vendor has a mobile number
    if (vendorPhone) {
      const { normalizePhoneToE164, sendSMS } = await import('@/lib/sms/telnyx')

      const e164 = normalizePhoneToE164(vendorPhone)
      if (e164) {
        const nteAmt     = (wo.nte_amount as number | null) ?? 0
        const nteLine    = nteAmt > 0 ? `\nNTE: $${nteAmt.toLocaleString()}` : ''
        const propName   = (property as { name: string } | null)?.name ?? 'Property'
        const portalUrl  = `${APP_URL}/work-orders/${token}`

        try {
          const smsBody = await renderSmsBody(membership.org_id, 'vendor_work_order', {
            vendor_name:   vendorName,
            wo_number:     wo.wo_number ?? '',
            property_name: propName,
            pm_name:       profile?.full_name ?? 'Your Property Manager',
            org_name:      org?.name ?? 'FieldStay Property Management',
            nte_amount:    nteAmt,
            window:        null,    // manual dispatch has no scheduled window
            nte_line:      nteLine,
            window_line:   '',
            portal_url:    portalUrl,
          })
          await sendSMS(e164, smsBody, { orgId: membership.org_id })
        } catch (smsErr) {
          console.error('[dispatchWorkOrderToVendor] SMS failed (non-fatal):', smsErr)
          reportError(smsErr, { site: 'serverAction.work-order-public.dispatchWorkOrderToVendor' })
        }
      }
    }

    revalidatePath('/maintenance')
    return { success: true, token, publicUrl: `${APP_URL}/work-orders/${token}` }

  } catch (err) {
    console.error('[dispatchWorkOrderToVendor]', err)
    reportError(err, { site: 'serverAction.work-order-public.dispatchWorkOrderToVendor' })
    return { error: 'Operation failed. Please try again.' }
  }
}
