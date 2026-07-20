import { requirePlatformAdmin } from '@/lib/auth'
import { Card } from '@/components/ui/Card'
import { InventoryCatalogEditor } from './inventory-catalog-editor'

export default async function InventoryCatalogPage() {
  const { supabase } = await requirePlatformAdmin()

  const { data: items } = await supabase
    .from('inventory_catalog')
    .select('id, name, category, default_unit, description, is_active')
    .order('category')
    .order('name')

  return (
    <Card>
      <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Inventory Catalog
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
        The global item list every org&apos;s inventory template picker reads
        from. Deactivating an item hides it from the picker for new
        selections without touching any org&apos;s already-added inventory
        items.
      </p>
      <InventoryCatalogEditor
        initialItems={(items ?? []).map((i) => ({
          id:           i.id,
          name:         i.name,
          category:     i.category,
          default_unit: i.default_unit,
          description:  i.description ?? '',
          is_active:    i.is_active,
        }))}
      />
    </Card>
  )
}
