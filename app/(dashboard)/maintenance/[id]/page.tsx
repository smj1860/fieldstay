import { requireOrgMember } from '@/lib/auth'
import { notFound } from 'next/navigation'
import { WorkOrderDetail } from './work-order-detail'

interface Props { params: Promise<{ id: string }> }

export default async function WorkOrderPage({ params }: Props) {
  const { id } = await params
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: wo },
    { data: updates },
    { data: photos },
    { data: quoteRequests },
    { data: vendors },
  ] = await Promise.all([
    supabase
      .from('work_orders')
      .select(`
        id, property_id, vendor_id, title, description,
        priority, status, source, source_schedule_id,
        scheduled_date, completed_date,
        estimated_cost, actual_cost, invoice_reference,
        portal_enabled, completion_token, completion_token_expires_at,
        completion_notes,
        created_at, updated_at,
        properties (id, name, city, state),
        vendors (id, name, specialty, email, phone)
      `)
      .eq('id', id)
      .eq('org_id', membership.org_id)
      .single(),

    supabase
      .from('work_order_updates')
      .select('id, status_from, status_to, notes, updated_via_vendor_portal, created_at')
      .eq('work_order_id', id)
      .order('created_at', { ascending: true }),

    supabase
      .from('work_order_photos')
      .select('id, storage_path, uploaded_by, caption, created_at')
      .eq('work_order_id', id)
      .order('created_at', { ascending: true }),

    supabase
      .from('quote_requests')
      .select('id, vendor_id, status, quoted_amount, quote_notes, sent_at, submitted_at, quote_token, quote_token_expires_at, vendors(id, name, specialty, email)')
      .eq('work_order_id', id)
      .order('created_at', { ascending: true }),

    supabase
      .from('vendors')
      .select('id, name, specialty')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
  ])

  if (!wo) notFound()

  return (
    <WorkOrderDetail
      workOrder={wo as never}
      updates={updates ?? []}
      photos={photos ?? []}
      quoteRequests={(quoteRequests ?? []) as never}
      vendors={vendors ?? []}
    />
  )
}
