import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { seedOrgInventoryCatalogIfNeeded } from '@/lib/inventory/seed-org-catalog'
import { InventorySubnav } from '@/components/templates/inventory-subnav'
import { CreateTemplateBuilder } from './create-template-builder'

export const metadata: Metadata = { title: 'Create Inventory Template — Templates — FieldStay' }

export default async function CreateInventoryTemplatePage() {
  const { supabase, membership } = await requireOrgMember()

  await seedOrgInventoryCatalogIfNeeded(membership.org_id)

  const [{ data: catalogItems, error: catalogError }, { data: properties, error: propertiesError }] = await Promise.all([
    supabase
      .from('org_inventory_catalog')
      .select('id, name, category, default_unit')
      .eq('org_id', membership.org_id)
      .order('category')
      .order('name'),
    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
  ])

  if (catalogError)    console.error('[CreateInventoryTemplatePage] catalog query failed', catalogError)
  if (propertiesError) console.error('[CreateInventoryTemplatePage] properties query failed', propertiesError)

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Inventory</h1>
        <p className="page-subtitle">
          Org-wide restock catalog and default par levels for every property.
        </p>
      </div>

      <InventorySubnav active="create" />

      <div className="mb-4">
        <h2 className="section-header mb-1">Create Template</h2>
        <p className="text-sm text-muted-themed">
          Select items from your Master List — checking a category selects
          every item in it. Quantities aren&apos;t set here; par levels are a
          per-property concept, set on the Par Levels screen after applying.
        </p>
      </div>

      <CreateTemplateBuilder
        catalogItems={catalogItems ?? []}
        properties={properties ?? []}
      />
    </div>
  )
}
