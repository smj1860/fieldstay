// lib/dexie/sync/work-orders.ts
//
// Pulls this crew member's assigned work orders (plus the properties they
// reference) into Dexie. Extracted out of DexieProvider's mount effect
// (lib/dexie/context.tsx).

import type { DexieSupabaseClient } from './types'
import { getDexieDb, type CrewWorkOrderRow, type PropertyRow } from '../schema'

export async function syncWorkOrders(
  supabase: DexieSupabaseClient,
  userId: string,
  crewMemberId: string,
): Promise<void> {
  const db = getDexieDb(userId)
  // Match the turnover window: surface WOs scheduled within the last two
  // weeks onward, plus any with no scheduled date yet.
  const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString().split('T')[0]!

  const { data: workOrders, error } = await supabase
    .from('work_orders')
    .select(
      'id, org_id, property_id, assigned_crew_member_id, title, description, ' +
      'status, priority, scheduled_date, wo_number, created_at'
    )
    .eq('assigned_crew_member_id', crewMemberId)
    .not('status', 'in', '("completed","cancelled")')
    .or(`scheduled_date.is.null,scheduled_date.gte.${twoWeeksAgo}`)
  if (error) {
    console.error('[work-orders sync] work_orders fetch failed:', error)
    return
  }

  if (workOrders?.length) {
    await db.crew_work_orders.bulkPut(workOrders as CrewWorkOrderRow[])

    // Ensure the properties referenced by these WOs are cached too, so the
    // crew home page and detail view can render names/addresses.
    const propertyIds = [
      ...new Set((workOrders as { property_id: string }[]).map((w) => w.property_id)),
    ]
    if (propertyIds.length) {
      const { data: properties } = await supabase
        .from('properties')
        .select('id, org_id, name, address, city, state, lat, lng, timezone')
        .in('id', propertyIds)
      if (properties?.length) await db.properties.bulkPut(properties as PropertyRow[])
    }
  }
}
