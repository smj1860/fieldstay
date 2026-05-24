import { requireProperty } from '@/lib/auth'
import { MaintenanceScheduleManager } from './maintenance-form'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Maintenance Schedules' }
interface Props { params: { id: string } }

export default async function MaintenancePage({ params }: Props) {
  const { property, supabase, membership } = await requireProperty(params.id)

  const [{ data: schedules }, { data: vendors }] = await Promise.all([
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
  ])

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
      />
    </div>
  )
}
