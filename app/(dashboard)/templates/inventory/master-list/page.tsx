import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { seedOrgInventoryCatalogIfNeeded } from '@/lib/inventory/seed-org-catalog'
import { InventorySubnav } from '@/components/templates/inventory-subnav'
import { MasterListEditor } from './master-list-editor'

export const metadata: Metadata = { title: 'Inventory Master List — Templates — FieldStay' }

export default async function MasterListPage() {
  const { supabase, membership } = await requireOrgMember()

  await seedOrgInventoryCatalogIfNeeded(membership.org_id)

  const { data: catalogItems, error } = await supabase
    .from('org_inventory_catalog')
    .select('id, name, category, default_unit')
    .eq('org_id', membership.org_id)
    .order('category')
    .order('name')

  if (error) console.error('[MasterListPage] catalog query failed', error)

  const canManage = membership.role !== 'viewer' && membership.role !== 'crew'

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Inventory</h1>
        <p className="page-subtitle">
          Org-wide restock catalog and default par levels for every property.
        </p>
      </div>

      <InventorySubnav active="master-list" />

      <div className="mb-4">
        <h2 className="section-header mb-1">Master List</h2>
        <p className="text-sm text-muted-themed">
          Your org&apos;s editable copy of the FieldStay starter catalog. Add,
          rename, or remove items here — changes never touch the shared
          platform catalog.
        </p>
      </div>

      <MasterListEditor
        initialItems={(catalogItems ?? []).map((item) => ({
          id:           item.id,
          name:         item.name,
          category:     item.category,
          default_unit: item.default_unit,
        }))}
        canManage={canManage}
      />
    </div>
  )
}
