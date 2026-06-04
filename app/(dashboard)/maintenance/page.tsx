import { requireOrgMember } from '@/lib/auth'
import { MaintenanceBoard } from './maintenance-board'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Maintenance' }

export default async function MaintenancePage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: workOrders },
    { data: properties },
    { data: vendors },
    { data: schedules },
  ] = await Promise.all([
    supabase
      .from('work_orders')
      .select(`
        id, property_id, vendor_id, assigned_crew_id,
        wo_number, title, description, category, priority, status, source,
        scheduled_date, completed_date,
        estimated_cost, nte_amount, actual_cost,
        access_notes, completion_notes, invoice_reference,
        portal_enabled, completion_token,
        vendor_acknowledged_at, vendor_acknowledged_by,
        completion_verified_at, completion_verified_by,
        created_at, updated_at,
        properties ( name, address, city, state, access_instructions ),
        vendors ( id, name, specialty ),
        work_order_line_items (
          id, line_type, description, quantity, unit,
          unit_cost, line_total, sort_order, created_at
        )
      `)
      .eq('org_id', membership.org_id)
      .order('created_at', { ascending: false }),

    supabase
      .from('properties')
      .select('id, name, city, state')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('vendors')
      .select('id, name, specialty')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('maintenance_schedules')
      .select(`
        id, property_id, org_id, name, description,
        schedule_type, frequency, month_due, next_due_date,
        last_completed_date, estimated_cost, auto_create_wo, is_active,
        assigned_vendor_id, instructions,
        properties ( name ),
        vendors ( id, name )
      `)
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('next_due_date', { ascending: true, nullsFirst: false }),
  ])

  return (
    <MaintenanceBoard
      workOrders={workOrders ?? []}
      properties={properties ?? []}
      vendors={vendors ?? []}
      schedules={schedules ?? []}
      role={membership.role}
    />
  )
}
