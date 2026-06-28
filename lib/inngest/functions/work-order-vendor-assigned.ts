import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { NonRetriableError }    from 'inngest'
import { randomBytes }          from 'crypto'

export const handleWorkOrderVendorAssigned = inngest.createFunction(
  { id: 'work-order-vendor-assigned', name: 'Work Order: Vendor Assigned', retries: 2 },
  { event: 'work-order/vendor.assigned' },
  async ({ event, step, logger }) => {
    const { workOrderId, orgId, vendorId } = event.data
    const supabase = createServiceClient()

    // ── Step 1: Fetch WO + vendor + property + org in parallel ───────────
    const { wo, vendor, property, org } = await step.run('fetch-context', async () => {
      const [woRes, vendorRes] = await Promise.all([
        supabase
          .from('work_orders')
          .select(`
            id, wo_number, title, description, nte_amount, scheduled_date,
            completion_token, completion_token_expires_at, portal_enabled,
            status, org_id, property_id, vendor_id
          `)
          .eq('id', workOrderId)
          .eq('org_id', orgId)
          .single(),
        supabase
          .from('vendors')
          .select('id, name, email, portal_enabled')
          .eq('id', vendorId)
          .eq('org_id', orgId)
          .single(),
      ])

      if (!woRes.data)     throw new NonRetriableError('Work order not found')
      if (!vendorRes.data) throw new NonRetriableError('Vendor not found')
      if (!vendorRes.data.email) {
        throw new NonRetriableError('Vendor has no email address — cannot dispatch')
      }

      const [propRes, orgRes] = await Promise.all([
        supabase
          .from('properties')
          .select('id, name, address')
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

    if (!vendor.portal_enabled) {
      logger.warn(`Vendor ${vendorId} has portal disabled — skipping dispatch`)
      return { skipped: true, reason: 'vendor_portal_disabled' }
    }

    // ── Step 2: Ensure completion_token exists ────────────────────────────
    // On first assignment the WO has no token. On reassignment it may already
    // have one — reuse it so the existing vendor link keeps working if shared.
    const token = await step.run('ensure-completion-token', async () => {
      if (wo.completion_token) return wo.completion_token

      const newToken   = randomBytes(32).toString('hex')
      const expiresAt  = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()

      const { error } = await supabase
        .from('work_orders')
        .update({
          completion_token:            newToken,
          completion_token_expires_at: expiresAt,
          portal_enabled:              true,
          status:                      'assigned',
          vendor_id:                   vendorId,
          updated_at:                  new Date().toISOString(),
        })
        .eq('id', workOrderId)
        .eq('org_id', orgId)

      if (error) throw new Error(`Failed to set completion token: ${error.message}`)
      return newToken
    })

    // ── Step 3: Fetch dispatcher name ────────────────────────────────────
    const dispatcher = await step.run('fetch-dispatcher', async () => {
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

    // ── Step 4: Fire dispatch event → sends the vendor email ─────────────
    const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
    const publicUrl = `${appUrl}/work-orders/${token}`

    await step.sendEvent('send-dispatch', {
      name: 'work-order/dispatched',
      data: {
        workOrderId,
        woNumber:        wo.wo_number ?? '',
        token,
        publicUrl,
        vendorEmail:     vendor.email,
        vendorName:      vendor.name ?? '',
        propertyName:    property?.name    ?? 'Property',
        propertyAddress: property?.address ?? '',
        title:           wo.title,
        description:     wo.description ?? '',
        nteAmount:       (wo.nte_amount as number | null) ?? 0,
        dispatcherName:  dispatcher.name,
        dispatcherOrg:   org?.name ?? 'FieldStay Property Management',
        dispatcherPhone: dispatcher.phone,
      },
    })

    logger.info(`Dispatched WO ${wo.wo_number} to ${vendor.email} via vendor-assigned handler`)
    return { dispatched: true, woNumber: wo.wo_number, vendorEmail: vendor.email }
  }
)
