import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { InventoryManager } from './inventory-manager'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type { Metadata } from 'next'
import type { CartBuildResult } from '@/lib/kroger/types'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'
import type { InventoryItem } from '@/types/database'

/** `select('*, property:properties(name)')` — the embed arrives as an array. */
type InventoryItemRow = InventoryItem & {
  property: { name: string } | { name: string }[] | null
}

export const metadata: Metadata = { title: 'Inventory' }

export default async function InventoryPage() {
  const { supabase, membership } = await requireOrgMember()

  // Fetched once, unfiltered by is_active, with the superset of columns both
  // `items` (active-only) and `allInventoryItems` (all statuses, portfolio-
  // wide) need — the two used to be separate queries against the same table.
  //
  // PAGINATED, not a bare .select(): at ~67 items per property this crosses
  // PostgREST's max_rows = 1000 at roughly FIFTEEN properties, which is inside
  // this product's stated 10–50 target. Because the sort is property_id first,
  // the truncation is not a partial list — every property sorted past the cut
  // renders with zero inventory, and the below-par counts, the restock UI and
  // the Kroger cart all compute off this array. It returns 200 with no error,
  // so nothing anywhere surfaces it. Kicked off before the Promise.all below
  // so it still runs concurrently with the other five reads.
  const allInventoryItemsPromise = fetchAllRows<InventoryItemRow>(
    (from, to) => supabase
      .from('inventory_items')
      .select('*, property:properties(name)')
      .eq('org_id', membership.org_id)
      .order('property_id')
      .order('category')
      .order('name')
      .order('id')   // stable tiebreaker — page boundaries must not shift
      .range(from, to),
    { label: 'page.inventory.inventory_items' },
  )

  const [
    { data: properties, error: propertiesError },
    { data: purchaseOrders, error: purchaseOrdersError },
    { data: catalogItems, error: catalogItemsError },
    { data: recentCounts, error: recentCountsError },
  ] = await Promise.all([
    supabase
      .from('properties')
      .select('id, name, city, state')
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
  ])

  // Logs + reports every failure, then throws so the segment's error.tsx
  // renders a real error state — an outage must not look like empty data.
  throwIfAnyQueryFailed({ site: 'page.inventory', orgId: membership.org_id }, propertiesError, purchaseOrdersError, catalogItemsError, recentCountsError)

  // fetchAllRows throws on a page error, which the segment's error.tsx turns
  // into the same real error state throwIfAnyQueryFailed produces above.
  const allInventoryItemsRaw = await allInventoryItemsPromise

  const { data: cartMilestone, error: cartMilestoneError } = await supabase
    .from('org_milestones')
    .select('value')
    .eq('org_id', membership.org_id)
    .eq('milestone', 'last_cart_build')
    .maybeSingle()


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.inventory', orgId: membership.org_id }, cartMilestoneError)
  const cartData  = (cartMilestone?.value ?? null) as (CartBuildResult & { built_at: string; location_name: string }) | null

  const normalizedAllInventoryItems = (allInventoryItemsRaw ?? []).map((item) => ({
    ...item,
    property: unwrapJoin(item.property),
  }))

  const items = normalizedAllInventoryItems
    .filter((item) => item.is_active)
    .sort((a, b) => a.name.localeCompare(b.name))

  const admin = createServiceClient({ authorizedBy: membership })
  const { data: krogerConnection, error: krogerConnectionError } = await admin
    .from('integration_connections')
    .select('id')
    .eq('org_id', membership.org_id)
    .eq('provider_id', 'kroger')
    .eq('status', 'active')
    .maybeSingle()


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.inventory', orgId: membership.org_id }, krogerConnectionError)
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
        cartData={cartData}
        showKrogerNudge={showKrogerNudge}
      />
    </div>
  )
}
