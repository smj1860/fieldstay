import { tryUnwrap } from '@/lib/supabase/unwrap'
import { NonRetriableError } from 'inngest'
import type { createServiceClient } from '@/lib/supabase/server'
import { getOrgDispatcher } from '@/lib/inngest/helpers'
import { render } from '@react-email/render'
import WorkOrderDispatchEmail from '@/emails/WorkOrderDispatch'
import { resend, FROM } from '@/lib/resend/client'
import { renderSmsBody } from '@/lib/sms/templates'
import { getManualUrlForAsset } from '@/lib/assets/manual-lookup'
import { reportError } from '@/lib/observability/report-error'
import { unwrapJoin } from '@/lib/utils/supabase-joins'

/**
 * Helpers for handleWorkOrderCreated's vendor-dispatch flow
 * (lib/inngest/functions/work-order-events.ts) — extracted so the context
 * load (WO/vendor/property/dispatcher/org lookups + completion-token
 * ensure) and the two outbound sends (email, SMS) can live in their own
 * `step.run()` calls. A step boundary is itself the idempotency guard here:
 * once a step returns successfully, Inngest never re-executes it on replay,
 * so splitting email and SMS into separate steps means a retry of one can
 * never re-trigger the other.
 */

// Both exported helpers below run inside Inngest steps, which always hand
// them the service-role client — typing it precisely (rather than the loose
// `SupabaseClient`) is what lets getOrgDispatcher() be called from here.
type ServiceClient = ReturnType<typeof createServiceClient>

export type DispatchContext =
  | {
      dispatched:      true
      vendorEmail:     string
      vendorPhone:     string | null
      vendorName:      string
      propertyName:    string
      propertyAddress: string
      publicUrl:       string
      woNumber:        string
      title:           string
      description:     string
      assetId:         string | null
      dispatcherName:  string
      dispatcherPhone: string | null
      orgName:         string
      nteAmount:       number
      // string | null (not | undefined) — this crosses a step.run() boundary
      // and gets JSON-serialized by Inngest; `undefined` fields become
      // optional keys in the deserialized type, which breaks the exact
      // discriminated-union match this type relies on downstream.
      vendorWindow:    string | null
    }
  | {
      dispatched: false
      reason:     'no_vendor_email'
      vendorName: string | null
    }

export async function loadDispatchContext(
  supabase:    ServiceClient,
  workOrderId: string,
  orgId:       string,
): Promise<DispatchContext> {
  const { data: wo, error: woErr } = await supabase
    .from('work_orders')
    .select(`
      id, title, description, wo_number, nte_amount,
      completion_token, asset_id,
      vendor_id,
      scheduled_date, scheduled_time,
      vendors ( name, email, phone ),
      properties ( name, address, timezone )
    `)
    .eq('id', workOrderId)
    .maybeSingle()

  if (woErr) {
    // A real query failure (not "zero rows") — worth Inngest's normal retry.
    throw new Error(`Work order ${workOrderId} query failed: ${woErr.message} (code: ${woErr.code})`)
  }

  if (!wo) {
    // Confirmed live 2026-07-25: the work order no longer exists by the
    // time this step runs — most likely an org-level cascade delete (see
    // FINDING-1's notifications_org_id_fkey fix) removed it out from under
    // an in-flight event. Non-retriable: retrying can't make a deleted row
    // reappear, and this reads as a clear one-line reason instead of
    // PostgREST's generic PGRST116 "Cannot coerce the result to a single
    // JSON object".
    throw new NonRetriableError(`Work order ${workOrderId} no longer exists — skipping vendor dispatch`)
  }

  const vendor   = unwrapJoin(wo.vendors)
  const property = unwrapJoin(wo.properties)

  // Build vendor window string for same-day flip dispatch
  let vendorWindow: string | undefined
  if (wo.scheduled_time && wo.scheduled_date) {
    const propTz = property?.timezone ?? 'America/New_York'
    const { formatPropertyTime } = await import('@/lib/utils/timezone')
    vendorWindow = formatPropertyTime(
      wo.scheduled_time.slice(0, 5),
      wo.scheduled_date,
      propTz,
      'long'
    )
  }

  if (!vendor?.email) {
    // Non-retriable: retrying will never produce an email address.
    // Return a structured failure so the PM notification step can handle it.
    return {
      dispatched:  false as const,
      reason:      'no_vendor_email' as const,
      vendorName:  vendor?.name ?? null,
    }
  }

  // Reuse existing completion_token if WO was created with portal enabled.
  // Only generate a new one if the WO somehow arrived here without one.
  let token = wo.completion_token
  if (!token) {
    // MUST be a UUID — completion_token is `uuid`, and the previous
    // randomBytes(32).toString('hex') is 64 characters, which Postgres rejects
    // with 22P02. Identical to the defect that made dispatchWorkOrderToVendor
    // fail on every call (fixed in #565); this is the same line in the other
    // dispatch path's fallback branch. Unreachable today — all three
    // `work-order/created` producers that set portal_enabled: true mint a
    // crypto.randomUUID() token first — so it never fired, but the failure
    // mode here is worse: it throws inside an Inngest step, so the dispatch
    // would retry and fail forever rather than returning a message.
    token = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    const { error: tokenErr } = await supabase
      .from('work_orders')
      .update({
        completion_token:            token,
        completion_token_expires_at: expiresAt,
        vendor_dispatch_email:       vendor.email,
        // The portal page filters .eq('portal_enabled', true). Reaching this
        // branch means the WO had no token, i.e. it was not created
        // portal-enabled — so minting a token without opening the gate would
        // email a link that renders notFound().
        portal_enabled:              true,
      })
      .eq('id', workOrderId)

    if (tokenErr) throw new Error(`Failed to write completion_token: ${tokenErr.message}`)
  } else {
    // Record dispatch email even if token was already set
    const { error: dispatchEmailErr } = await supabase
      .from('work_orders')
      .update({ vendor_dispatch_email: vendor.email })
      .eq('id', workOrderId)

    if (dispatchEmailErr) throw new Error(`Failed to record vendor_dispatch_email: ${dispatchEmailErr.message}`)
  }

  // Dispatcher info — use org owner/admin since work_orders has no created_by
  // column. Selection goes through getOrgDispatcher so the person named here
  // is the same one work-order-vendor-assigned.ts names on the SMS for this
  // work order (see that helper's note on determinism).
  const { name: dispatcherName, phone: dispatcherPhone } =
    await getOrgDispatcher(supabase, orgId, 'Your Property Manager')

  const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
  const publicUrl = `${appUrl}/work-orders/${token}`

  const propertyName    = (property as { name: string } | null)?.name    ?? 'Property'
  const propertyAddress = (property as { address: string | null } | null)?.address ?? ''

  // Fetch org name for the dispatcher email footer
  // Degrade, don't throw: orgName already has a sensible default and this
  // only fills an email footer. tryUnwrap still logs and reports.
  let orgName = 'FieldStay Property Management'
  const orgRes = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .maybeSingle()

  const orgOut = tryUnwrap(orgRes, { site: 'inngest.work-order-events.org-name', orgId })
  if (orgOut.ok && orgOut.data?.name) orgName = orgOut.data.name

  return {
    dispatched:      true as const,
    vendorEmail:     vendor.email,
    vendorPhone:     vendor.phone ?? null,
    vendorName:      vendor.name ?? '',
    propertyName,
    propertyAddress,
    publicUrl,
    woNumber:        wo.wo_number ?? '',
    title:           wo.title,
    description:     wo.description ?? '',
    assetId:         wo.asset_id ?? null,
    dispatcherName,
    dispatcherPhone,
    orgName,
    nteAmount:       (wo.nte_amount as number | null) ?? 0,
    vendorWindow:    vendorWindow ?? null,
  }
}

/** Sends the vendor dispatch email. Assumes `context.dispatched === true`. */
export async function sendVendorDispatchEmail(
  workOrderId: string,
  context:     Extract<DispatchContext, { dispatched: true }>,
  supabase:    ServiceClient,
  orgId:       string,
): Promise<void> {
  const manualUrl = await getManualUrlForAsset(supabase, orgId, context.assetId)

  const html = await render(WorkOrderDispatchEmail({
    woNumber:        context.woNumber,
    publicUrl:       context.publicUrl,
    vendorName:      context.vendorName,
    propertyName:    context.propertyName,
    propertyAddress: context.propertyAddress,
    title:           context.title,
    description:     context.description,
    nteAmount:       context.nteAmount,
    dispatcherName:  context.dispatcherName,
    dispatcherOrg:   context.orgName,
    dispatcherPhone: context.dispatcherPhone,
    manualUrl,
  }))

  const { error: emailErr } = await resend.emails.send(
    {
      from:    FROM,
      to:      [context.vendorEmail],
      subject: `Work Order ${context.woNumber} — ${context.propertyName}`,
      html,
    },
    { idempotencyKey: `wo-dispatch-created-${workOrderId}-${context.vendorEmail}` }
  )

  if (emailErr) throw new Error(`Resend error: ${JSON.stringify(emailErr)}`)
}

/**
 * Sends the vendor dispatch SMS, when the vendor has a mobile number.
 * Non-fatal by design — a Telnyx failure here must not abort the rest of
 * handleWorkOrderCreated (notify-pm, Stripe Connect invite), so errors are
 * caught and logged rather than thrown.
 */
export async function sendVendorDispatchSms(
  orgId:   string,
  context: Extract<DispatchContext, { dispatched: true }>,
): Promise<void> {
  if (!context.vendorPhone) return

  const { normalizePhoneToE164, sendSMS } = await import('@/lib/sms/telnyx')
  const e164 = normalizePhoneToE164(context.vendorPhone)
  if (!e164) return

  const nteLine    = context.nteAmount > 0 ? `\nNTE: $${context.nteAmount.toLocaleString()}` : ''
  const windowLine = context.vendorWindow
    ? `\nAvailable window: ${context.vendorWindow}\nProperty must be ready before guest check-in.`
    : ''

  try {
    const smsBody = await renderSmsBody(orgId, 'vendor_work_order', {
      vendor_name:   context.vendorName,
      wo_number:     context.woNumber,
      property_name: context.propertyName,
      pm_name:       context.dispatcherName,
      org_name:      context.orgName,
      nte_amount:    context.nteAmount,
      window:        context.vendorWindow,
      nte_line:      nteLine,
      window_line:   windowLine,
      portal_url:    context.publicUrl,
    })
    await sendSMS(e164, smsBody, { orgId })
  } catch (smsErr) {
    console.error('[WO dispatch-to-vendor] SMS failed (non-fatal):', smsErr)
    reportError(smsErr, { site: 'inngest.work-order-dispatch.sms', orgId })
  }
}
