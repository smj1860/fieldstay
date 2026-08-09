import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { NonRetriableError }    from 'inngest'
import { render }               from '@react-email/render'
import WorkOrderDispatchEmail   from '@/emails/WorkOrderDispatch'
import { resend, FROM }         from '@/lib/resend/client'
import { createPmNotification, getOrgDispatcher } from '@/lib/inngest/helpers'
import { renderSmsBody }        from '@/lib/sms/templates'
import { getManualUrlForAsset } from '@/lib/assets/manual-lookup'
import { reportError }          from '@/lib/observability/report-error'
import { unwrap }               from '@/lib/supabase/unwrap'

export const handleWorkOrderVendorAssigned = inngest.createFunction(
  {
    id: 'work-order-vendor-assigned', name: 'Work Order: Vendor Assigned', retries: 2,
    // Batch-dispatched (a bulk vendor assignment emits one per work order) and
    // notifies the vendor externally.
    concurrency: { limit: 5 },
    throttle:    { limit: 60, period: '1m' },
  },
  { event: 'work-order/vendor.assigned' },
  async ({ event, step, logger }) => {
    const { workOrderId, orgId, vendorId } = event.data

    // ── Step 1: Fetch WO + vendor + property + org in parallel ───────────
    const { wo, vendor, hasVendorEmail, hasVendorPhone, property, org } = await step.run('fetch-context', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-vendor-assigned' })
      const [woRes, vendorRes] = await Promise.all([
        supabase
          .from('work_orders')
          .select(`
            id, wo_number, title, description, nte_amount, scheduled_date,
            scheduled_time, portal_enabled,
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

      // A step's return value is persisted as Inngest execution history and
      // rendered in a third-party console. This file was putting four things
      // in there on every dispatch: the work order's completion_token, the
      // vendor's email, the vendor's phone, and (in step 3) the dispatcher's
      // phone.
      //
      // completion_token is the one that matters. It is a bearer credential
      // for /work-orders/<token>, an UNAUTHENTICATED route — holding it is
      // holding access to the job, its photos and its completion flow. The
      // codebase already knows this rule: guidebook-guest-opted-in.ts decrypts
      // a door code "inside this step, and never returned from it — step
      // return values are persisted as Inngest execution history". Same
      // surface, same reasoning, not applied here.
      //
      // So the token is reduced to a boolean and re-read by the one step that
      // needs it, and the vendor's contact details are dropped in favour of
      // the two booleans the control flow below actually branches on. Both
      // reads are single-row by primary key.
      const { email: vendorEmail, phone: vendorPhone, ...vendorSafe } = vendorRes.data

      return {
        wo:            woRes.data,
        vendor:        vendorSafe,
        hasVendorEmail: !!vendorEmail,
        hasVendorPhone: !!vendorPhone,
        property:      propRes.data,
        org:           orgRes.data,
      }
    })

    // Gate on WO's portal_enabled — this is the PM's explicit intent for this
    // work order. vendor.portal_enabled is a profile preference but the PM's
    // per-WO decision is authoritative.
    if (!wo.portal_enabled) {
      logger.warn(`WO ${workOrderId}: portal_enabled=false — skipping vendor dispatch`)
      return { skipped: true, reason: 'wo_portal_disabled' }
    }

    if (!hasVendorEmail) {
      // Can't dispatch without an email — vendor.email is required at
      // creation via the standard Add Vendor form. No PM alert here:
      // this is now a silent skip (see bulkImportVendors gap noted
      // separately if this ever fires from a bulk-imported vendor).
      logger.warn(`WO ${workOrderId}: vendor ${vendorId} has no email — cannot dispatch`)
      return { skipped: true, reason: 'no_vendor_email' }
    }

    // ── Step 2: Ensure completion_token exists ─────────────────────────────
    //
    // Returns nothing. This step used to hand the token back so the URL could
    // be built at the top level — which persisted it a second time, on top of
    // step 1's copy. The consuming steps read it themselves now.
    await step.run('ensure-completion-token', async () => {
      const supabase  = createServiceClient({ system: 'inngest:work-order-vendor-assigned' })

      // inngest-history-safe: returns { created: boolean } only — the token is
      // read, compared against null, and discarded inside this closure.
      //
      // Read the existing token HERE rather than carrying it down from step 1.
      // Step 1 no longer selects the column at all, so there is exactly one
      // place in this function that touches it and it is inside a step that
      // returns a boolean.
      const existingRes = await supabase
        .from('work_orders')
        .select('completion_token')
        .eq('id', workOrderId)
        .eq('org_id', orgId)
        .single()

      if (unwrap(existingRes, {
        site: 'inngest.work-order-vendor-assigned.existing-token', orgId,
      })?.completion_token) {
        return { created: false }
      }

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
      return { created: true }
    })

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'

    /**
     * Read the completion token inside the step that needs it, so it never
     * enters a step's return value. Single row by primary key, org-scoped.
     */
    async function readPublicUrl(supabase: ReturnType<typeof createServiceClient>): Promise<string> {
      const res = await supabase
        .from('work_orders')
        .select('completion_token')
        .eq('id', workOrderId)
        .eq('org_id', orgId)
        .single()

      const row = unwrap(res, { site: 'inngest.work-order-vendor-assigned.read-token', orgId })
      if (!row?.completion_token) {
        throw new Error(`Work order ${workOrderId} has no completion_token after ensure step`)
      }
      return `${appUrl}/work-orders/${row.completion_token}`
    }

    /** Same reasoning as readPublicUrl: the vendor's email and phone are
     *  resolved inside the step that sends to them, never carried across a
     *  step boundary where the run history would keep a copy. */
    async function readVendorContact(supabase: ReturnType<typeof createServiceClient>) {
      const res = await supabase
        .from('vendors')
        .select('email, phone')
        .eq('id', vendorId)
        .eq('org_id', orgId)
        .single()

      return unwrap(res, { site: 'inngest.work-order-vendor-assigned.read-vendor-contact', orgId })
        ?? { email: null, phone: null }
    }

    // ── Step 3: Fetch dispatcher ───────────────────────────────────────────
    // Name only. The dispatcher's phone number is a PM's personal contact
    // detail and was being written into the run history on every dispatch;
    // the steps that put it in an email or an SMS resolve it themselves.
    const dispatcherName = await step.run('fetch-dispatcher', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-vendor-assigned' })
      const { name } = await getOrgDispatcher(
        supabase,
        orgId,
        org?.name ?? 'Property Management'
      )
      return name
    })

    // ── Step 4: Send vendor email directly (no secondary event hop) ────────
    const propertyName    = property?.name    ?? 'Property'
    const propertyAddress = property?.address ?? ''

    await step.run('send-vendor-email', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-vendor-assigned' })
      const manualUrl = await getManualUrlForAsset(supabase, orgId, wo.asset_id ?? null)

      // Token, recipient address and dispatcher phone are all resolved HERE
      // and consumed HERE — none of them survives into this step's return
      // value, which is what the run history records.
      const publicUrl = await readPublicUrl(supabase)
      const { phone: dispatcherPhone } = await getOrgDispatcher(
        supabase, orgId, org?.name ?? 'Property Management',
      )
      const vendorEmail = await readVendorContact(supabase)

      const html = await render(WorkOrderDispatchEmail({
        woNumber:        wo.wo_number ?? '',
        publicUrl,
        vendorName:      vendor.name   ?? '',
        propertyName,
        propertyAddress,
        title:           wo.title,
        description:     wo.description ?? '',
        nteAmount:       (wo.nte_amount as number | null) ?? 0,
        dispatcherName:  dispatcherName,
        dispatcherOrg:   org?.name ?? 'FieldStay Property Management',
        dispatcherPhone,
        manualUrl,
      }))

      const { error } = await resend.emails.send(
        {
          from:    FROM,
          to:      [vendorEmail.email!],
          subject: `Work Order ${wo.wo_number ?? ''} — ${propertyName}`,
          html,
        },
        { idempotencyKey: `wo-dispatch-vendor-assigned-${workOrderId}-${vendorId}` }
      )

      if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`)
    })

    // SMS — alongside email when vendor has a mobile number
    if (hasVendorPhone) {
      await step.run('send-vendor-sms', async () => {
        const { normalizePhoneToE164, sendSMS } =
          await import('@/lib/sms/telnyx')

        const supabase = createServiceClient({ system: 'inngest:work-order-vendor-assigned' })
        const { phone: vendorPhone } = await readVendorContact(supabase)

        const e164 = normalizePhoneToE164(vendorPhone!)
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
          pm_name:       dispatcherName,
          org_name:      org?.name     ?? 'FieldStay Property Management',
          nte_amount:    nteAmount,
          window:        vendorWindow ?? null,   // raw — used by renderDefault → buildVendorWorkOrderSMS
          nte_line:      nteLine,                // pre-formatted — used by {{nte_line}} in custom template
          window_line:   windowLine,             // pre-formatted — used by {{window_line}} in custom template
          portal_url:    await readPublicUrl(supabase),
        })

        try {
          await sendSMS(e164, smsBody, { orgId })
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

    // Vendor id, not the vendor's email address. Both this log line (Axiom)
    // and this return value (Inngest run history) are durable third-party
    // records; notify-assignment-gap.ts documents the same decision for PM
    // recipients — "returning recipients: ['pm@example.com'] put PM email
    // addresses into a third-party console".
    logger.info(`Dispatched WO ${wo.wo_number} to vendor ${vendorId} via vendor-assigned handler`)
    return { dispatched: true, woNumber: wo.wo_number, vendorId }
  }
)
