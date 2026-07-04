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
    { data: crewMembers },
    { data: propertyAssets },
    { data: vendorCompliance },
    { data: templates },
  ] = await Promise.all([
    supabase
      .from('work_orders')
      .select(`
        id, property_id, vendor_id, assigned_crew_member_id,
        wo_number, title, description, category, priority, status, source,
        scheduled_date, completed_date,
        estimated_cost, nte_amount, actual_cost,
        access_notes, completion_notes, invoice_reference,
        portal_enabled, completion_token,
        vendor_acknowledged_at, vendor_acknowledged_by,
        completion_verified_at, completion_verified_by,
        vendor_dispatch_email,
        created_at, updated_at,
        properties ( name, address, city, state, access_instructions ),
        vendors ( id, name, specialty, phone ),
        work_order_line_items (
          id, line_type, description, quantity, unit,
          unit_cost, line_total, sort_order, created_at
        )
      `)
      .eq('org_id', membership.org_id)
      .in('status', ['pending', 'quote_requested', 'assigned', 'in_progress'])
      .order('created_at', { ascending: false }),

    supabase
      .from('properties')
      .select('id, name, city, state, lat, lng')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('vendors')
      .select('id, name, specialty, lat, lng, email')
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

    supabase
      .from('crew_members')
      .select('id, name, role')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('property_assets')
      .select('id, name, asset_type, property_id')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('vendor_compliance_status')
      .select('vendor_id, compliance_status')
      .eq('org_id', membership.org_id),

    supabase
      .from('maintenance_schedule_templates')
      .select(`
        id, org_id, name, description, is_system,
        maintenance_schedule_template_items (
          id, name, description, schedule_frequency, vendor_specialty_hint,
          estimated_cost, is_optional_flag, sort_order
        )
      `)
      .order('is_system', { ascending: false })
      .order('name')
      .order('sort_order', { referencedTable: 'maintenance_schedule_template_items', ascending: true }),
  ])

  return (
    <MaintenanceBoard
      workOrders={workOrders ?? []}
      properties={properties ?? []}
      vendors={vendors ?? []}
      schedules={schedules ?? []}
      templates={templates ?? []}
      crewMembers={crewMembers ?? []}
      propertyAssets={propertyAssets ?? []}
      vendorCompliance={vendorCompliance ?? []}
      orgId={membership.org_id}
      role={membership.role}
    />
  )
}
