import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { InventorySubnav } from '@/components/templates/inventory-subnav'
import { SavedTemplatesBrowser } from './saved-templates-browser'

export const metadata: Metadata = { title: 'Saved Inventory Templates — Templates — FieldStay' }

export default async function SavedInventoryTemplatesPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: templates, error: templatesError },
    { data: usageRows, error: usageError },
    { data: properties, error: propertiesError },
  ] = await Promise.all([
    supabase
      .from('inventory_templates')
      .select('id, name, description, inventory_template_items(id, name, category, unit, par_level, notes, preferred_brand, sort_order)')
      .eq('org_id', membership.org_id)
      .order('name'),
    supabase
      .from('inventory_items')
      .select('source_template_id, property_id')
      .eq('org_id', membership.org_id)
      .not('source_template_id', 'is', null),
    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
  ])

  if (templatesError)  console.error('[SavedInventoryTemplatesPage] templates query failed', templatesError)
  if (usageError)      console.error('[SavedInventoryTemplatesPage] usage query failed', usageError)
  if (propertiesError) console.error('[SavedInventoryTemplatesPage] properties query failed', propertiesError)

  const propertyNameById: Record<string, string> = {}
  for (const property of properties ?? []) propertyNameById[property.id] = property.name

  const propertyIdsByTemplate: Record<string, string[]> = {}
  for (const row of usageRows ?? []) {
    if (!row.source_template_id) continue
    const bucket = propertyIdsByTemplate[row.source_template_id] ?? []
    if (!bucket.includes(row.property_id)) bucket.push(row.property_id)
    propertyIdsByTemplate[row.source_template_id] = bucket
  }

  const canManage = membership.role !== 'viewer' && membership.role !== 'crew'

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Inventory</h1>
        <p className="page-subtitle">
          Org-wide restock catalog and default par levels for every property.
        </p>
      </div>

      <InventorySubnav active="saved" />

      <div className="mb-4">
        <h2 className="section-header mb-1">Saved Templates</h2>
        <p className="text-sm text-muted-themed">
          Every template your org has created. Select one to see which
          properties use it, apply it elsewhere, or edit its items.
        </p>
      </div>

      <SavedTemplatesBrowser
        templates={(templates ?? []).map((t) => ({
          id:          t.id,
          name:        t.name,
          description: t.description,
          items: [...(t.inventory_template_items ?? [])]
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((item) => ({
              id:              item.id,
              name:            item.name,
              category:        item.category,
              unit:            item.unit,
              par_level:       item.par_level,
              notes:           item.notes,
              preferred_brand: item.preferred_brand,
            })),
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
