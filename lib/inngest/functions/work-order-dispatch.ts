import { inngest }             from '@/lib/inngest/client'
import { resend, FROM }        from '@/lib/resend/client'
import { render }              from '@react-email/render'
import WorkOrderDispatchEmail  from '@/emails/WorkOrderDispatch'
import WorkOrderSignOffEmail   from '@/emails/WorkOrderSignOff'
import { createServiceClient } from '@/lib/supabase/server'

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
      nteAmount, dispatcherName, dispatcherOrg, dispatcherPhone,
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
      const supabase = createServiceClient()

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
      workOrderId, woNumber, title, signOffNotes, signedOffAt,
      propertyName, propertyAddress, orgId, orgName, vendorEmail
    } = event.data

    // ── Step 1: Find PM email from org admin/manager ─────────────────────
    const pmEmail = await step.run('find-pm-email', async () => {
      const supabase = createServiceClient()

      const { data: members } = await supabase
        .from('organization_members')
        .select('user_id, role')
        .eq('org_id', orgId)
        .in('role', ['owner', 'admin', 'manager'])
        .not('invite_accepted_at', 'is', null)

      if (!members?.length) return null

      // Prefer owner → admin → manager order
      const roleOrder = ['owner', 'admin', 'manager']
      const sorted = [...members].sort(
        (a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role)
      )

      const userId = sorted[0].user_id as string

      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', userId)
        .single()

      // Auth email via admin API
      const { data: { user } } = await supabase.auth.admin.getUserById(userId)

      return {
        email:    user?.email ?? null,
        fullName: profile?.full_name ?? 'Property Manager',
      }
    })

    if (!pmEmail?.email) {
      return { skipped: 'No PM email address found' }
    }

    // ── Step 2: Notify PM ─────────────────────────────────────────────────
    await step.run('notify-pm', async () => {
      const html = await render(WorkOrderSignOffEmail({
        woNumber,
        title,
        propertyName,
        propertyAddress,
        vendorName:   vendorEmail ?? null,
        signOffNotes: signOffNotes ?? null,
        signedOffAt,
        pmName:       pmEmail.fullName,
      }))
      const { error } = await resend.emails.send(
        {
          from:    FROM,
          to:      [pmEmail.email!],
          subject: `✓ Work Complete — ${woNumber} · ${propertyName}`,
          html,
        },
        { idempotencyKey: `work-order-signed-off-pm-${workOrderId}` }
      )
      if (error) throw new Error(`Resend sign-off error: ${JSON.stringify(error)}`)
    })

    // ── Step 3: Log sign-off to communication_logs ────────────────────────
    await step.run('log-signoff', async () => {
      const supabase = createServiceClient()

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
