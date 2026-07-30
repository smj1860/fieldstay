import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { InventorySubnav } from '@/components/templates/inventory-subnav'
import { ParLevelsBrowser } from './par-levels-browser'

export const metadata: Metadata = { title: 'Par Levels — Templates — FieldStay' }

export default async function ParLevelsPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: properties, error: propertiesError },
    { data: items, error: itemsError },
    { data: templates, error: templatesError },
    { data: catalogItems, error: catalogError },
    { data: consumptionStats, error: statsError },
  ] = await Promise.all([
    supabase
      .from('properties')
      .select('id, name, bathrooms, bedrooms, max_guests, avg_stay_length')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('inventory_items')
      .select('id, property_id, catalog_item_id, source_template_id, name, category, unit, par_level, par_mode, smart_group, base_qty, auto_adjust, par_resolved_at, preferred_brand')
      .eq('org_id', membership.org_id)
      .eq('is_active', true),
    supabase
      .from('inventory_templates')
      .select('id, name')
      .eq('org_id', membership.org_id),
    supabase
      .from('org_inventory_catalog')
      .select('id, name, category, default_unit, default_par_level, par_mode, smart_group, base_qty')
      .eq('org_id', membership.org_id)
      .order('category')
      .order('name'),
    supabase
      .from('inventory_consumption_stats')
      .select('property_id, inventory_item_id, avg_rate_per_guest_night, sample_count')
      .eq('org_id', membership.org_id),
  ])

  if (propertiesError) console.error('[ParLevelsPage] properties query failed', propertiesError)
  if (itemsError)      console.error('[ParLevelsPage] inventory_items query failed', itemsError)
  if (templatesError)  console.error('[ParLevelsPage] templates query failed', templatesError)
  if (catalogError)    console.error('[ParLevelsPage] catalog query failed', catalogError)
  if (statsError)      console.error('[ParLevelsPage] consumption stats query failed', statsError)

  const templateNameById: Record<string, string> = {}
  for (const template of templates ?? []) templateNameById[template.id] = template.name

  const canManage = membership.role !== 'viewer' && membership.role !== 'crew'

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Inventory</h1>
        <p className="page-subtitle">
          Org-wide restock catalog and default par levels for every property.
        </p>
      </div>

      <InventorySubnav active="par-levels" />

      <div className="mb-4">
        <h2 className="section-header mb-1">Par Levels</h2>
        <p className="text-sm text-muted-themed">
          Which template each property&apos;s inventory came from, and the
          per-property editor for adding items or adjusting par levels.
        </p>
      </div>

      <ParLevelsBrowser
        properties={properties ?? []}
        items={items ?? []}
        templateNameById={templateNameById}
        catalogItems={catalogItems ?? []}
        consumptionStats={consumptionStats ?? []}
        canManage={canManage}
      />
    </div>
  )
}
