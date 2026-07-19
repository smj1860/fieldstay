import { NonRetriableError } from 'inngest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { render } from '@react-email/render'
import WorkOrderDispatchEmail from '@/emails/WorkOrderDispatch'
import { resend, FROM } from '@/lib/resend/client'
import { renderSmsBody } from '@/lib/sms/templates'
import { getManualUrlForAsset } from '@/lib/assets/manual-lookup'
import { reportError } from '@/lib/observability/report-error'
import { randomBytes } from 'crypto'

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
  supabase:    SupabaseClient,
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
    .single()

  if (woErr || !wo) {
    throw new NonRetriableError(
      `Work order ${workOrderId} query failed: ${woErr?.message ?? 'not found'} ` +
      `(code: ${woErr?.code ?? 'unknown'})`
    )
  }

  const vendor   = Array.isArray(wo.vendors)    ? wo.vendors[0]    : wo.vendors
  const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties

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
    token = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    const { error: tokenErr } = await supabase
      .from('work_orders')
      .update({
        completion_token:            token,
        completion_token_expires_at: expiresAt,
        vendor_dispatch_email:       vendor.email,
      })
      .eq('id', workOrderId)

    if (tokenErr) throw new Error(`Failed to write completion_token: ${tokenErr.message}`)
  } else {
    // Record dispatch email even if token was already set
    await supabase
      .from('work_orders')
      .update({ vendor_dispatch_email: vendor.email })
      .eq('id', workOrderId)
  }

  // Dispatcher info — use org owner/admin since work_orders has no created_by column
  let dispatcherName  = 'Your Property Manager'
  let dispatcherPhone: string | null = null

  const { data: dispatchMembers } = await supabase
    .from('organization_members')
    .select('user_id')
    .eq('org_id', orgId)
    .in('role', ['owner', 'admin'])
    .not('invite_accepted_at', 'is', null)
    .limit(1)

  if (dispatchMembers?.[0]?.user_id) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, phone')
      .eq('id', dispatchMembers[0].user_id)
      .single()
    if (profile?.full_name) dispatcherName = profile.full_name
    if (profile?.phone)     dispatcherPhone = profile.phone
  }

  const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
  const publicUrl = `${appUrl}/work-orders/${token}`

  const propertyName    = (property as { name: string } | null)?.name    ?? 'Property'
  const propertyAddress = (property as { address: string | null } | null)?.address ?? ''

  // Fetch org name for the dispatcher email footer
  let orgName = 'FieldStay Property Management'
  const { data: orgRow } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single()
  if (orgRow?.name) orgName = orgRow.name

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
  supabase:    SupabaseClient,
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
    await sendSMS(e164, smsBody)
  } catch (smsErr) {
    console.error('[WO dispatch-to-vendor] SMS failed (non-fatal):', smsErr)
    reportError(smsErr, { site: 'inngest.work-order-dispatch.sms', orgId })
  }
}
