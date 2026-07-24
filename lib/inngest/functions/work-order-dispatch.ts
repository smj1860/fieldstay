import { inngest }             from '@/lib/inngest/client'
import { resend, FROM }        from '@/lib/resend/client'
import { render }              from '@react-email/render'
import WorkOrderDispatchEmail  from '@/emails/WorkOrderDispatch'
import { createServiceClient } from '@/lib/supabase/server'
import { ensureVendorConnectInvited } from '@/lib/stripe/vendor-connect-invite'
import { getPmMembers, createPmNotification } from '@/lib/inngest/helpers'

export const workOrderDispatch = inngest.createFunction(
  {
    id:      'work-order-dispatch',
    name:    'Send Work Order to Vendor',
    retries: 3,
  },
  { event: 'work-order/dispatched' },

  async ({ event, step }) => {
    const {
      workOrderId, woNumber, publicUrl, vendorEmail, vendorName,
      propertyName, propertyAddress, title, description,
      nteAmount, dispatcherName, dispatcherOrg, dispatcherPhone, manualUrl,
    } = event.data

    // ── Step 1: Send email to vendor ────────────────────────────────────
    await step.run('send-vendor-email', async () => {
      const html = await render(WorkOrderDispatchEmail({
        woNumber,
        publicUrl,
        vendorName,
        propertyName,
        propertyAddress,
        title,
        description,
        nteAmount,
        dispatcherName,
        dispatcherOrg,
        dispatcherPhone,
        manualUrl,
      }))
      const { error } = await resend.emails.send(
        {
          from:    FROM,
          to:      [vendorEmail],
          subject: `Work Order ${woNumber} — ${propertyName}`,
          html,
        },
        { idempotencyKey: `work-order-dispatch-${workOrderId}-${vendorEmail}` }
      )
      if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`)
    })

    // ── Step 2: Log to communication_logs ────────────────────────────────
    await step.run('log-to-comms', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-dispatch' })

      // Use PK (workOrderId) — not wo_number — to avoid cross-org ambiguity
      // if two orgs share the same wo_number string.
      const { data: wo } = await supabase
        .from('work_orders')
        .select('id, org_id, vendor_id, property_id')
        .eq('id', workOrderId)
        .single()

      if (!wo) return { skipped: 'work order not found for comms log' }

      const subject  = `Work Order ${woNumber} — ${propertyName}`
      const dedupKey = `wo-dispatch:${workOrderId}`

      const { error } = await supabase.from('communication_logs').insert({
        org_id:          wo.org_id,
        channel:         'email',
        recipient_type:  'vendor',
        vendor_id:       wo.vendor_id ?? null,
        work_order_id:   wo.id,
        property_id:     wo.property_id,
        subject,
        body:            `Work order dispatched to ${vendorEmail}. Public URL: ${publicUrl}`,
        source:          'system',
        communicated_at: new Date().toISOString(),
        dedup_key:       dedupKey,
      })

      if (error) {
        if (error.code === '23505') return { logged: false, alreadyExisted: true }
        throw error
      }

      return { logged: true }
    })

    // ── Step 3: Bundle the Stripe Connect invite with dispatch, not just the
    // nightly cron (CLAUDE_62_0) — a vendor dispatched a work order the same
    // day they were added would otherwise wait for the next 07:00 UTC cron
    // run before getting a payout setup link at all.
    await step.run('invite-vendor-to-connect-if-needed', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-dispatch' })

      const { data: wo } = await supabase
        .from('work_orders')
        .select('org_id, vendor_id, wo_number')
        .eq('id', workOrderId)
        .single()

      if (!wo?.vendor_id) return { skipped: 'no vendor on work order' }

      const { data: vendor } = await supabase
        .from('vendors')
        .select('id, name, email, stripe_connect_account_id, stripe_connect_invite_sent_at, stripe_connect_token')
        .eq('id', wo.vendor_id)
        .eq('org_id', wo.org_id)
        .single()

      if (!vendor?.email || vendor.stripe_connect_account_id || vendor.stripe_connect_invite_sent_at) {
        return { skipped: 'already invited or no email' }
      }

      const { invited } = await ensureVendorConnectInvited({
        vendorId:           vendor.id,
        orgId:              wo.org_id,
        vendorEmail:        vendor.email,
        vendorName:         vendor.name,
        vendorConnectToken: vendor.stripe_connect_token!,
        orgName:            dispatcherOrg,
        pmName:             dispatcherName,
        woNumber:           wo.wo_number,
      })

      return { invited }
    })

    return { dispatched: true, vendorEmail, woNumber }
  }
)

export const workOrderSignedOff = inngest.createFunction(
  {
    id:      'work-order-signed-off',
    name:    'Notify PM of Work Order Sign-Off',
    retries: 3,
  },
  { event: 'work-order/signed-off' },

  async ({ event, step }) => {
    const {
      workOrderId, woNumber, signOffNotes, signedOffAt,
      propertyName, orgId,
    } = event.data

    // ── Step 1: Find PM email from org owner/admin/manager ───────────────
    const pmEmail = await step.run('find-pm-email', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-dispatch' })
      const [member] = await getPmMembers(supabase, orgId, { roles: ['owner', 'admin', 'manager'], limit: 1 })
      if (!member) return null

      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', member.userId)
        .single()

      return {
        email:    member.email,
        fullName: profile?.full_name ?? 'Property Manager',
      }
    })

    if (!pmEmail?.email) {
      return { skipped: 'No PM email address found' }
    }

    // ── Step 2: Notify PM ─────────────────────────────────────────────────
    await step.run('notify-pm', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-dispatch' })
      await createPmNotification(supabase, {
        orgId,
        type:      'work_order_complete',
        title:     `✓ Work Complete — ${woNumber} · ${propertyName}`,
        subtitle:  signOffNotes ? `Signed off — ${signOffNotes}` : 'Vendor signed off with no notes',
        href:      `/maintenance/${workOrderId}`,
        severity:  'green',
        dedupeKey: `work-order-signed-off-pm-${workOrderId}`,
      })
    })

    // ── Step 3: Log sign-off to communication_logs ────────────────────────
    await step.run('log-signoff', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-dispatch' })

      const { data: wo } = await supabase
        .from('work_orders')
        .select('org_id, vendor_id, property_id')
        .eq('id', workOrderId)
        .single()

      if (!wo) return { skipped: true }

      const subject  = `Work Order Signed Off — ${woNumber}`
      const dedupKey = `wo-signoff:${workOrderId}`

      const { error } = await supabase.from('communication_logs').insert({
        org_id:          wo.org_id,
        channel:         'note',
        recipient_type:  'vendor',
        vendor_id:       wo.vendor_id ?? null,
        work_order_id:   workOrderId,
        property_id:     wo.property_id,
        subject,
        body:            signOffNotes
                           ? `Vendor signed off. Notes: ${signOffNotes}`
                           : 'Vendor signed off with no notes.',
        source:          'system',
        communicated_at: signedOffAt,
        dedup_key:       dedupKey,
      })

      if (error) {
        if (error.code === '23505') return { logged: false, alreadyExisted: true }
        throw error
      }
    })

    return { notified: true, pmEmail: pmEmail.email, woNumber }
  }
)
