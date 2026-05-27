import { requireOrgMember } from '@/lib/auth'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { WorkOrderDetail } from './work-order-detail'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Work Order' }

export default async function WorkOrderPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: workOrder },
    { data: updates },
    { data: vendors },
  ] = await Promise.all([
    supabase
      .from('work_orders')
      .select(`
        id, property_id, vendor_id, assigned_crew_id,
        title, description, priority, status, source,
        scheduled_date, completed_date,
        estimated_cost, actual_cost,
        portal_enabled, completion_token, completion_notes,
        invoice_reference, created_at, updated_at,
        properties ( id, name, city, state ),
        vendors ( id, name, specialty, email, phone )
      `)
      .eq('id', id)
      .eq('org_id', membership.org_id)
      .single(),

    supabase
      .from('work_order_updates')
      .select('id, status_from, status_to, notes, updated_via_vendor_portal, created_at')
      .eq('work_order_id', id)
      .eq('org_id', membership.org_id)
      .order('created_at', { ascending: true }),

    supabase
      .from('vendors')
      .select('id, name, specialty')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
  ])

  if (!workOrder) notFound()

  return (
    <div>
      <div className="mb-4">
        <Link href="/maintenance" className="text-sm text-accent-500 hover:text-accent-700 transition-colors flex items-center gap-1">
          ← Back to Maintenance
        </Link>
      </div>
      <WorkOrderDetail
        workOrder={workOrder as never}
        updates={updates ?? []}
        vendors={(vendors ?? []) as { id: string; name: string; specialty: string }[]}
      />
    </div>
  )
}
