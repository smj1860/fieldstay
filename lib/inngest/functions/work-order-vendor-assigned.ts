import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { NonRetriableError }    from 'inngest'
import { render }               from '@react-email/render'
import WorkOrderDispatchEmail   from '@/emails/WorkOrderDispatch'
import { resend, FROM }         from '@/lib/resend/client'
import { createPmNotification } from '@/lib/inngest/helpers'
import { renderSmsBody }        from '@/lib/sms/templates'
import { getManualUrlForAsset } from '@/lib/assets/manual-lookup'
import { reportError }          from '@/lib/observability/report-error'

export const handleWorkOrderVendorAssigned = inngest.createFunction(
  { id: 'work-order-vendor-assigned', name: 'Work Order: Vendor Assigned', retries: 2 },
  { event: 'work-order/vendor.assigned' },
  async ({ event, step, logger }) => {
    const { workOrderId, orgId, vendorId } = event.data

    // ── Step 1: Fetch WO + vendor + property + org in parallel ───────────
    const { wo, vendor, property, org } = await step.run('fetch-context', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-vendor-assigned' })
      const [woRes, vendorRes] = await Promise.all([
        supabase
          .from('work_orders')
          .select(`
            id, wo_number, title, description, nte_amount, scheduled_date,
            scheduled_time, completion_token, completion_token_expires_at, portal_enabled,
            status, org_id, property_id, vendor_id, asset_id
          `)
          .eq('id', workOrderId)
          .eq('org_id', orgId)
          .single(),
        supabase
          .from('vendors')
          .select('id, name, email, phone, portal_enabled')
          .eq('id', vendorId)
          .eq('org_id', orgId)
          .single(),
      ])

      if (!woRes.data)     throw new NonRetriableError('Work order not found')
      if (!vendorRes.data) throw new NonRetriableError('Vendor not found')

      const [propRes, orgRes] = await Promise.all([
        supabase
          .from('properties')
          .select('id, name, address, timezone')
          .eq('id', woRes.data.property_id)
          .single(),
        supabase
          .from('organizations')
          .select('id, name')
          .eq('id', orgId)
          .single(),
      ])

      return {
        wo:       woRes.data,
        vendor:   vendorRes.data,
        property: propRes.data,
        org:      orgRes.data,
      }
    })

    // Gate on WO's portal_enabled — this is the PM's explicit intent for this
    // work order. vendor.portal_enabled is a profile preference but the PM's
    // per-WO decision is authoritative.
    if (!wo.portal_enabled) {
      logger.warn(`WO ${workOrderId}: portal_enabled=false — skipping vendor dispatch`)
      return { skipped: true, reason: 'wo_portal_disabled' }
    }

    if (!vendor.email) {
      // Can't dispatch without an email — vendor.email is required at
      // creation via the standard Add Vendor form. No PM alert here:
      // this is now a silent skip (see bulkImportVendors gap noted
      // separately if this ever fires from a bulk-imported vendor).
      logger.warn(`WO ${workOrderId}: vendor ${vendorId} has no email — cannot dispatch`)
      return { skipped: true, reason: 'no_vendor_email' }
    }

    // ── Step 2: Ensure completion_token exists ─────────────────────────────
    const token = await step.run('ensure-completion-token', async () => {
      if (wo.completion_token) return wo.completion_token

      const supabase  = createServiceClient({ system: 'inngest:work-order-vendor-assigned' })
      const newToken  = crypto.randomUUID()
      const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()

      const { error } = await supabase
        .from('work_orders')
        .update({
          completion_token:            newToken,
          completion_token_expires_at: expiresAt,
          portal_enabled:              true,
          status:                      'assigned',
          vendor_id:                   vendorId,
        })
        .eq('id', workOrderId)
        .eq('org_id', orgId)

      if (error) throw new Error(`Failed to set completion_token: ${error.message}`)
      return newToken
    })

    // ── Step 3: Fetch dispatcher ───────────────────────────────────────────
    const dispatcher = await step.run('fetch-dispatcher', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-vendor-assigned' })
      const { data: members } = await supabase
        .from('organization_members')
        .select('user_id')
        .eq('org_id', orgId)
        .in('role', ['owner', 'admin'])
        .not('invite_accepted_at', 'is', null)
        .limit(1)

      if (!members?.[0]?.user_id) {
        return { name: org?.name ?? 'Property Management', phone: null }
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, phone')
        .eq('id', members[0].user_id)
        .single()

      return {
        name:  profile?.full_name ?? org?.name ?? 'Property Management',
        phone: profile?.phone     ?? null,
      }
    })

    // ── Step 4: Send vendor email directly (no secondary event hop) ────────
    const appUrl      = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
    const publicUrl   = `${appUrl}/work-orders/${token}`
    const propertyName    = property?.name    ?? 'Property'
    const propertyAddress = property?.address ?? ''

    await step.run('send-vendor-email', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-vendor-assigned' })
      const manualUrl = await getManualUrlForAsset(supabase, orgId, wo.asset_id ?? null)

      const html = await render(WorkOrderDispatchEmail({
        woNumber:        wo.wo_number ?? '',
        publicUrl,
        vendorName:      vendor.name   ?? '',
        propertyName,
        propertyAddress,
        title:           wo.title,
        description:     wo.description ?? '',
        nteAmount:       (wo.nte_amount as number | null) ?? 0,
        dispatcherName:  dispatcher.name,
        dispatcherOrg:   org?.name ?? 'FieldStay Property Management',
        dispatcherPhone: dispatcher.phone,
        manualUrl,
      }))

      const { error } = await resend.emails.send(
        {
          from:    FROM,
          to:      [vendor.email!],
          subject: `Work Order ${wo.wo_number ?? ''} — ${propertyName}`,
          html,
        },
        { idempotencyKey: `wo-dispatch-vendor-assigned-${workOrderId}-${vendorId}` }
      )

      if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`)
    })

    // SMS — alongside email when vendor has a mobile number
    if (vendor.phone) {
      await step.run('send-vendor-sms', async () => {
        const { normalizePhoneToE164, sendSMS } =
          await import('@/lib/sms/telnyx')

        const e164 = normalizePhoneToE164(vendor.phone!)
        if (!e164) return { skipped: true, reason: 'invalid-phone' }

        let vendorWindow: string | undefined
        if (wo.scheduled_time && wo.scheduled_date) {
          const { formatPropertyTime } = await import('@/lib/utils/timezone')
          const propTz = property?.timezone ?? 'America/New_York'
          vendorWindow = formatPropertyTime(
            wo.scheduled_time.slice(0, 5),
            wo.scheduled_date,
            propTz,
            'long'
          )
        }

        const nteAmount = (wo.nte_amount as number | null) ?? 0
        const nteLine   = nteAmount > 0 ? `\nNTE: $${nteAmount.toLocaleString()}` : ''
        const windowLine = vendorWindow
          ? `\nAvailable window: ${vendorWindow}\nProperty must be ready before guest check-in.`
          : ''

        const smsBody = await renderSmsBody(orgId, 'vendor_work_order', {
          vendor_name:   vendor.name   ?? '',
          wo_number:     wo.wo_number  ?? '',
          property_name: propertyName,
          pm_name:       dispatcher.name,
          org_name:      org?.name     ?? 'FieldStay Property Management',
          nte_amount:    nteAmount,
          window:        vendorWindow ?? null,   // raw — used by renderDefault → buildVendorWorkOrderSMS
          nte_line:      nteLine,                // pre-formatted — used by {{nte_line}} in custom template
          window_line:   windowLine,             // pre-formatted — used by {{window_line}} in custom template
          portal_url:    publicUrl,
        })

        try {
          await sendSMS(e164, smsBody)
        } catch (smsErr) {
          console.error('[WO vendor-assigned] SMS failed (non-fatal):', smsErr)
          reportError(smsErr, { site: 'inngest.work-order-vendor-assigned.sms', orgId })
          return { sent: false, reason: 'send-failed' }
        }
        return { sent: true }
      })
    }

    // ── Step 5: Notify PM that vendor was dispatched ───────────────────────
    await step.run('notify-pm-dispatched', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-vendor-assigned' })
      await createPmNotification(supabase, {
        orgId,
        type:      'work_order_dispatched',
        title:     `Work order dispatched — ${wo.wo_number ?? ''} · ${propertyName}`,
        subtitle:  `${vendor.name ?? 'The assigned vendor'} was notified and can access job details via their portal link`,
        href:      `/maintenance/${workOrderId}`,
        severity:  'green',
        dedupeKey: `wo-pm-notified-vendor-assigned-${workOrderId}-${vendorId}`,
      })
      return { notified: true }
    })

    logger.info(`Dispatched WO ${wo.wo_number} to ${vendor.email} via vendor-assigned handler`)
    return { dispatched: true, woNumber: wo.wo_number, vendorEmail: vendor.email }
  }
)
