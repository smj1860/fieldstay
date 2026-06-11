import { requireProperty } from '@/lib/auth'
import { MaintenanceScheduleManager } from './maintenance-form'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Maintenance Schedules' }
interface Props { params: Promise<{ id: string }> }

export default async function MaintenancePage({ params }: Props) {
  const { id } = await params
  const { property, supabase, membership } = await requireProperty(id)

  const [{ data: schedules }, { data: vendors }, { data: siblingSchedules }] = await Promise.all([
    supabase
      .from('maintenance_schedules')
      .select('*, vendors(name)')
      .eq('property_id', property.id)
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
      .select('property_id, properties!inner(name)')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .neq('property_id', property.id),
  ])

  const scheduleCountByProperty: Record<string, number> = {}
  const propNameBySchedule: Record<string, string> = {}
  for (const row of siblingSchedules ?? []) {
    scheduleCountByProperty[row.property_id] = (scheduleCountByProperty[row.property_id] ?? 0) + 1
    const p = Array.isArray(row.properties) ? row.properties[0] : row.properties
    if (p?.name) propNameBySchedule[row.property_id] = p.name
  }
  const sourceProperties = Object.entries(scheduleCountByProperty)
    .map(([sid, scheduleCount]) => ({ id: sid, name: propNameBySchedule[sid] ?? sid, scheduleCount }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-accent-900 mb-1">Maintenance Schedules</h2>
      <p className="text-sm text-accent-500 mb-6">
        Set up routine and seasonal maintenance. FieldStay checks every morning and alerts
        you — or auto-creates a work order — when something is due.
      </p>
      <MaintenanceScheduleManager
        propertyId={property.id}
        schedules={schedules ?? []}
        vendors={vendors ?? []}
        sourceProperties={sourceProperties}
      />
    </div>
  )
}
