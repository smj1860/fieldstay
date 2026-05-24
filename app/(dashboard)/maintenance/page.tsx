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
        title, description, priority, status, source,
        scheduled_date, completed_date,
        estimated_cost, actual_cost,
        portal_enabled, completion_notes,
        created_at, updated_at,
        properties ( name ),
        vendors ( name )
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
        id, property_id, name, description,
        schedule_type, frequency, next_due_date,
        last_completed_date, estimated_cost, auto_create_wo, is_active,
        assigned_vendor_id,
        properties ( name )
      `)
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('next_due_date', { ascending: true }),
  ])

  return (
    <MaintenanceBoard
      workOrders={workOrders ?? []}
      properties={properties ?? []}
      vendors={vendors ?? []}
      schedules={schedules ?? []}
    />
  )
}
