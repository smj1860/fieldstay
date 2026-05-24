import { requireProperty } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { InventorySetup } from './inventory-setup'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Inventory Setup' }

interface Props { params: { id: string } }

export default async function InventoryPage({ params }: Props) {
  const { property, supabase } = await requireProperty(params.id)

  const [{ data: catalogItems }, { data: propertyItems }] = await Promise.all([
    supabase
      .from('inventory_catalog')
      .select('*')
      .eq('is_active', true)
      .order('category')
      .order('name'),
    supabase
      .from('inventory_items')
      .select('*')
      .eq('property_id', property.id)
      .eq('is_active', true)
      .order('category')
      .order('name'),
  ])

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-accent-900 mb-1">Inventory</h2>
      <p className="text-sm text-accent-500 mb-6">
        Add items to track for this property. Set a par level — when crew counts
        fall below it, FieldStay generates a purchase order for you.
      </p>
      <InventorySetup
        propertyId={property.id}
        catalogItems={catalogItems ?? []}
        existingItems={propertyItems ?? []}
      />
    </div>
  )
}
