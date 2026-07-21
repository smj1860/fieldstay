import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { MaintenanceSubnav } from '@/components/templates/maintenance-subnav'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { SavedTemplatesBrowser } from './saved-templates-browser'

export const metadata: Metadata = { title: 'Saved Maintenance Templates — Templates — FieldStay' }

export default async function SavedMaintenanceTemplatesPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: templates, error: templatesError },
    { data: usageRows, error: usageError },
    { data: properties, error: propertiesError },
  ] = await Promise.all([
    // No org_id filter — RLS already scopes this to the caller's own
    // org's templates plus the always-visible is_system one, same as
    // the query this replaces in app/(dashboard)/maintenance/page.tsx.
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
    supabase
      .from('maintenance_schedules')
      .select('property_id, source_template_item_id, maintenance_schedule_template_items(template_id)')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .not('source_template_item_id', 'is', null),
    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
  ])

  if (templatesError)  console.error('[SavedMaintenanceTemplatesPage] templates query failed', templatesError)
  if (usageError)      console.error('[SavedMaintenanceTemplatesPage] usage query failed', usageError)
  if (propertiesError) console.error('[SavedMaintenanceTemplatesPage] properties query failed', propertiesError)

  const propertyNameById: Record<string, string> = {}
  for (const property of properties ?? []) propertyNameById[property.id] = property.name

  const propertyIdsByTemplate: Record<string, string[]> = {}
  for (const row of usageRows ?? []) {
    const templateId = unwrapJoin(row.maintenance_schedule_template_items)?.template_id
    if (!templateId) continue
    const bucket = propertyIdsByTemplate[templateId] ?? []
    if (!bucket.includes(row.property_id)) bucket.push(row.property_id)
    propertyIdsByTemplate[templateId] = bucket
  }

  const canManage = membership.role !== 'viewer' && membership.role !== 'crew'

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Scheduled Maintenance</h1>
        <p className="page-subtitle">
          Org-wide recurring maintenance catalog and default schedules.
        </p>
      </div>

      <MaintenanceSubnav active="saved" />

      <div className="mb-4">
        <h2 className="section-header mb-1">Saved Templates</h2>
        <p className="text-sm text-muted-themed">
          Select a template to see which properties use it, apply it
          elsewhere, or edit its items. The FieldStay standard template is
          read-only.
        </p>
      </div>

      <SavedTemplatesBrowser
        templates={(templates ?? []).map((t) => ({
          id:          t.id,
          name:        t.name,
          description: t.description,
          isSystem:    t.is_system,
          items:       t.maintenance_schedule_template_items ?? [],
          propertyNames: (propertyIdsByTemplate[t.id] ?? [])
            .map((pid) => propertyNameById[pid])
            .filter((name): name is string => !!name)
            .sort((a, b) => a.localeCompare(b)),
        }))}
        allProperties={properties ?? []}
        canManage={canManage}
      />
    </div>
  )
}
