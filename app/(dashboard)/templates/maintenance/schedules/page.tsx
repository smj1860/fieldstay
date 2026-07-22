import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { MaintenanceSubnav } from '@/components/templates/maintenance-subnav'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { SchedulesBrowser } from './schedules-browser'

export const metadata: Metadata = { title: 'Maintenance Schedules — Templates — FieldStay' }

export default async function MaintenanceSchedulesPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: properties, error: propertiesError },
    { data: schedules, error: schedulesError },
    { data: templates, error: templatesError },
    { data: vendors, error: vendorsError },
  ] = await Promise.all([
    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('maintenance_schedules')
      .select(`
        id, property_id, name, description, schedule_type, frequency, month_due,
        next_due_date, estimated_cost, auto_create_wo, assigned_vendor_id, instructions,
        source_template_item_id,
        maintenance_schedule_template_items ( template_id )
      `)
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('next_due_date', { ascending: true, nullsFirst: false }),
    supabase
      .from('maintenance_schedule_templates')
      .select('id, name'),
    supabase
      .from('vendors')
      .select('id, name, specialty')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
  ])

  if (propertiesError) console.error('[MaintenanceSchedulesPage] properties query failed', propertiesError)
  if (schedulesError)  console.error('[MaintenanceSchedulesPage] schedules query failed', schedulesError)
  if (templatesError)  console.error('[MaintenanceSchedulesPage] templates query failed', templatesError)
  if (vendorsError)    console.error('[MaintenanceSchedulesPage] vendors query failed', vendorsError)

  const templateNameById: Record<string, string> = {}
  for (const template of templates ?? []) templateNameById[template.id] = template.name

  const scheduleRows = (schedules ?? []).map((s) => ({
    id:                 s.id,
    property_id:        s.property_id,
    name:               s.name,
    description:        s.description,
    schedule_type:      s.schedule_type,
    frequency:          s.frequency,
    month_due:          s.month_due,
    next_due_date:      s.next_due_date,
    estimated_cost:     s.estimated_cost,
    auto_create_wo:     s.auto_create_wo,
    assigned_vendor_id: s.assigned_vendor_id,
    instructions:       s.instructions,
    template_id:        unwrapJoin(s.maintenance_schedule_template_items)?.template_id ?? null,
  }))

  const canManage = membership.role !== 'viewer' && membership.role !== 'crew'

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Scheduled Maintenance</h1>
        <p className="page-subtitle">
          Org-wide recurring maintenance catalog and default schedules.
        </p>
      </div>

      <MaintenanceSubnav active="schedules" />

      <div className="mb-4">
        <h2 className="section-header mb-1">Schedules</h2>
        <p className="text-sm text-muted-themed">
          Which template each property&apos;s maintenance schedule came from,
          and the per-property editor for adjusting frequency, due dates,
          vendors, and auto-create.
        </p>
      </div>

      <SchedulesBrowser
        properties={properties ?? []}
        schedules={scheduleRows}
        templateNameById={templateNameById}
        vendors={vendors ?? []}
        canManage={canManage}
      />
    </div>
  )
}
