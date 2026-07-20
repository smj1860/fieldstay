import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { InventoryManager } from './inventory-manager'
import type { Metadata } from 'next'
import type { CartBuildResult } from '@/lib/kroger/types'

export const metadata: Metadata = { title: 'Inventory' }

export default async function InventoryPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: properties },
    { data: allInventoryItemsRaw },
    { data: purchaseOrders },
    { data: catalogItems },
    { data: recentCounts },
    { data: templates },
    { data: pendingDrafts },
  ] = await Promise.all([
    supabase
      .from('properties')
      .select('id, name, city, state')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
    // Fetched once, unfiltered by is_active, with the superset of columns
    // both `items` (active-only) and `allInventoryItems` (all statuses,
    // portfolio-wide) need — the two used to be separate queries against
    // the same table, fetching up to ~2,500 rows twice per page load.
    supabase
      .from('inventory_items')
      .select('*, property:properties(name)')
      .eq('org_id', membership.org_id)
      .order('property_id')
      .order('category')
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
      .limit(20),
    supabase
      .from('inventory_catalog')
      .select('id, name, category, default_unit')
      .eq('is_active', true)
      .order('category')
      .order('name'),
    supabase
      .from('inventory_counts')
      .select('id, property_id, submitted_at, notes')
      .eq('org_id', membership.org_id)
      .order('submitted_at', { ascending: false })
      .limit(50),
    supabase
      .from('inventory_templates')
      .select('id, name, inventory_template_items(id, name, category, unit, par_level, notes, sort_order, preferred_brand)')
      .eq('org_id', membership.org_id)
      .limit(1),
    supabase
      .from('inventory_count_drafts')
      .select(`
        id, property_id, status, created_at, notes,
        crew_members!submitted_by(name),
        inventory_count_draft_items(
          id, item_id, previous_quantity, counted_qty, notes,
          inventory_items(name, unit)
        )
      `)
      .eq('org_id', membership.org_id)
      .eq('status', 'pending_review')
      .order('created_at', { ascending: false }),
  ])

  const { data: cartMilestone } = await supabase
    .from('org_milestones')
    .select('value')
    .eq('org_id', membership.org_id)
    .eq('milestone', 'last_cart_build')
    .maybeSingle()

  const template  = templates?.[0] ?? null
  const cartData  = (cartMilestone?.value ?? null) as (CartBuildResult & { built_at: string; location_name: string }) | null

  const normalizedAllInventoryItems = (allInventoryItemsRaw ?? []).map((item) => ({
    ...item,
    property: Array.isArray(item.property)
      ? (item.property[0] ?? null)
      : (item.property ?? null),
  }))

  const items = normalizedAllInventoryItems
    .filter((item) => item.is_active)
    .sort((a, b) => a.name.localeCompare(b.name))

  const admin = createServiceClient()
  const { data: krogerConnection } = await admin
    .from('integration_connections')
    .select('id')
    .eq('org_id', membership.org_id)
    .eq('provider_id', 'kroger')
    .eq('status', 'active')
    .maybeSingle()

  const showKrogerNudge = !krogerConnection

  return (
    <div>
      <InventoryManager
        properties={properties ?? []}
        items={items ?? []}
        purchaseOrders={purchaseOrders ?? []}
        catalogItems={catalogItems ?? []}
        recentCounts={recentCounts ?? []}
        allInventoryItems={normalizedAllInventoryItems}
        template={template}
        pendingDrafts={pendingDrafts ?? []}
        cartData={cartData}
        showKrogerNudge={showKrogerNudge}
      />
    </div>
  )
}
