import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { InventorySubnav } from '@/components/templates/inventory-subnav'
import { ParLevelsBrowser } from './par-levels-browser'
import { fetchAllRows } from '@/lib/inngest/paginate'
import type { InventoryCategory } from '@/types/database'

/** Mirrors ParLevelsBrowser's ItemRow — the columns this page selects. */
interface ParLevelItem {
  id:                 string
  property_id:        string
  catalog_item_id:    string | null
  source_template_id: string | null
  name:               string
  category:           InventoryCategory
  unit:               string
  par_level:          number
  preferred_brand:    string | null
}

export const metadata: Metadata = { title: 'Par Levels — Templates — FieldStay' }

export default async function ParLevelsPage() {
  const { supabase, membership } = await requireOrgMember()

  // Paginated: org-wide inventory_items crosses PostgREST's max_rows = 1000 at
  // roughly 15 properties (~67 items each), and a bare .select() truncates
  // there silently with a 200 — this browser would simply stop showing par
  // levels for the rest of the portfolio.
  const itemsPromise = fetchAllRows<ParLevelItem>(
    (from, to) => supabase
      .from('inventory_items')
      .select('id, property_id, catalog_item_id, source_template_id, name, category, unit, par_level, preferred_brand')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('id')
      .range(from, to),
    { label: 'page.templates.par-levels.inventory_items' },
  )

  const [
    { data: properties, error: propertiesError },
    { data: templates, error: templatesError },
    { data: catalogItems, error: catalogError },
  ] = await Promise.all([
    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('inventory_templates')
      .select('id, name')
      .eq('org_id', membership.org_id),
    supabase
      .from('org_inventory_catalog')
      .select('id, name, category, default_unit')
      .eq('org_id', membership.org_id)
      .order('category')
      .order('name'),
  ])

  if (propertiesError) console.error('[ParLevelsPage] properties query failed', propertiesError)
  if (templatesError)  console.error('[ParLevelsPage] templates query failed', templatesError)
  if (catalogError)    console.error('[ParLevelsPage] catalog query failed', catalogError)

  const items = await itemsPromise

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
        canManage={canManage}
      />
    </div>
  )
}
