import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { MaintenanceSubnav } from '@/components/templates/maintenance-subnav'
import { CreateTemplateBuilder } from './create-template-builder'

export const metadata: Metadata = { title: 'Create Maintenance Template — Templates — FieldStay' }

export default async function CreateMaintenanceTemplatePage() {
  const { supabase, membership } = await requireOrgMember()

  const [{ data: systemTemplate, error: systemError }, { data: properties, error: propertiesError }] = await Promise.all([
    supabase
      .from('maintenance_schedule_templates')
      .select('id, maintenance_schedule_template_items(id, name, description, schedule_frequency, vendor_specialty_hint, estimated_cost, is_optional_flag, sort_order)')
      .eq('is_system', true)
      .order('sort_order', { referencedTable: 'maintenance_schedule_template_items', ascending: true })
      .maybeSingle(),
    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
  ])

  if (systemError)     console.error('[CreateMaintenanceTemplatePage] system template query failed', systemError)
  if (propertiesError) console.error('[CreateMaintenanceTemplatePage] properties query failed', propertiesError)

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Scheduled Maintenance</h1>
        <p className="page-subtitle">
          Org-wide recurring maintenance catalog and default schedules.
        </p>
      </div>

      <MaintenanceSubnav active="create" />

      <div className="mb-4">
        <h2 className="section-header mb-1">Create Template</h2>
        <p className="text-sm text-muted-themed">
          Select from the FieldStay standard schedule, type in your own
          items, or both — then apply to whichever properties get picked in
          the same flow.
        </p>
      </div>

      <CreateTemplateBuilder
        catalogItems={systemTemplate?.maintenance_schedule_template_items ?? []}
        properties={properties ?? []}
      />
    </div>
  )
}
