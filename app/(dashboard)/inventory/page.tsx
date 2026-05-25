import { requireOrgMember } from '@/lib/auth'
import { InventoryManager } from './inventory-manager'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Inventory' }

export default async function InventoryPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: properties },
    { data: items },
    { data: purchaseOrders },
    { data: catalogItems },
  ] = await Promise.all([
    supabase
      .from('properties')
      .select('id, name, city, state')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('inventory_items')
      .select('*')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('purchase_orders')
      .select(`
        id, property_id, status, generated_at, total_estimated_cost,
        purchase_order_items (
          id, item_name, quantity_to_buy, par_level, current_quantity, estimated_unit_cost
        )
      `)
      .eq('org_id', membership.org_id)
      .order('generated_at', { ascending: false })
      .limit(10),
    supabase
      .from('inventory_catalog')
      .select('id, name, category, default_unit')
      .eq('is_active', true)
      .order('category')
      .order('name'),
  ])

  return (
    <div>
      <InventoryManager
        properties={properties ?? []}
        items={items ?? []}
        purchaseOrders={purchaseOrders ?? []}
        catalogItems={catalogItems ?? []}
      />
    </div>
  )
}
