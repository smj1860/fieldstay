import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { InventoryManager } from './inventory-manager'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type { Metadata } from 'next'
import type { CartBuildResult } from '@/lib/kroger/types'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export const metadata: Metadata = { title: 'Inventory' }

export default async function InventoryPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: properties, error: propertiesError },
    { data: allInventoryItemsRaw, error: allInventoryItemsRawError },
    { data: purchaseOrders, error: purchaseOrdersError },
    { data: catalogItems, error: catalogItemsError },
    { data: recentCounts, error: recentCountsError },
    { data: pendingDrafts, error: pendingDraftsError },
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

  // Logs + reports every failure, then throws so the segment's error.tsx
  // renders a real error state — an outage must not look like empty data.
  throwIfAnyQueryFailed({ site: 'page.inventory', orgId: membership.org_id }, propertiesError, allInventoryItemsRawError, purchaseOrdersError, catalogItemsError, recentCountsError, pendingDraftsError)

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
        pendingDrafts={pendingDrafts ?? []}
        cartData={cartData}
        showKrogerNudge={showKrogerNudge}
      />
    </div>
  )
}
