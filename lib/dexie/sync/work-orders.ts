// lib/dexie/sync/work-orders.ts
//
// Pulls this crew member's assigned work orders (plus the properties they
// reference) into Dexie. Extracted out of DexieProvider's mount effect
// (lib/dexie/context.tsx).
//
// Sync-v2 shape (crew sync Phase 1): an id-only snapshot of the crew
// member's current open WOs is always fetched and reconciled against the
// local cache — that's what removes completed/cancelled/reassigned-away
// WOs from the device (the old pull was bulkPut-only, so a WO that left
// the crew member's plate lingered locally until a full page reload).
// Row data then transfers via an updated_at cursor: full on first pull or
// force, delta afterwards.

import type { DexieSupabaseClient } from './types'
import { getDexieDb, type CrewWorkOrderRow, type PropertyRow } from '../schema'
import { getCursor, advanceCursor } from './cursors'

const WO_COLUMNS =
  'id, org_id, property_id, assigned_crew_member_id, title, description, ' +
  'status, priority, scheduled_date, wo_number, created_at, updated_at'

export async function syncWorkOrders(
  supabase: DexieSupabaseClient,
  userId: string,
  crewMemberId: string,
  force = false,
): Promise<void> {
  const db = getDexieDb(userId)
  // Match the turnover window: surface WOs scheduled within the last two
  // weeks onward, plus any with no scheduled date yet.
  const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString().split('T')[0]!

  const scoped = () => supabase
    .from('work_orders')
    .select(WO_COLUMNS)
    .eq('assigned_crew_member_id', crewMemberId)
    .not('status', 'in', '("completed","cancelled")')
    .or(`scheduled_date.is.null,scheduled_date.gte.${twoWeeksAgo}`)

  const cursor = force ? null : await getCursor(userId, 'cursor:work_orders')

  let fetched: Record<string, unknown>[]
  let currentIds: Set<string>

  if (cursor === null) {
    // Full pull: the data fetch doubles as the membership snapshot
    const { data, error } = await scoped()
    if (error) {
      console.error('[work-orders sync] work_orders fetch failed:', error)
      return
    }
    fetched = (data ?? []) as unknown as Record<string, unknown>[]
    currentIds = new Set(fetched.map((w) => w.id as string))
  } else {
    // Delta pull: id-only membership snapshot + changed rows
    const { data: idRows, error: idError } = await supabase
      .from('work_orders')
      .select('id')
      .eq('assigned_crew_member_id', crewMemberId)
      .not('status', 'in', '("completed","cancelled")')
      .or(`scheduled_date.is.null,scheduled_date.gte.${twoWeeksAgo}`)
    if (idError) {
      console.error('[work-orders sync] work_orders id snapshot failed:', idError)
      return
    }
    currentIds = new Set((idRows ?? []).map((w: { id: string }) => w.id))

    const { data, error } = await scoped().gt('updated_at', cursor)
    if (error) {
      console.error('[work-orders sync] work_orders delta fetch failed:', error)
      return
    }
    fetched = (data ?? []) as unknown as Record<string, unknown>[]
  }

  // Reconcile: anything cached locally that's no longer in the crew
  // member's open set (completed, cancelled, or reassigned away) is removed.
  const staleIds = (await db.crew_work_orders.toArray())
    .map((w) => w.id)
    .filter((id) => !currentIds.has(id))
  if (staleIds.length) {
    await db.crew_work_orders.bulkDelete(staleIds)
  }

  if (fetched.length) {
    const rows = fetched.map((w) => {
      // updated_at feeds the cursor only — keep the Dexie row shape unchanged
      const { updated_at: _updatedAt, ...row } = w
      return row
    })
    await db.crew_work_orders.bulkPut(rows as unknown as CrewWorkOrderRow[])

    // Ensure the properties referenced by these WOs are cached too, so the
    // crew home page and detail view can render names/addresses. Only ids
    // the device doesn't already have — reference data, rarely changes.
    const cachedPropertyIds = new Set((await db.properties.toArray()).map((p) => p.id))
    const propertyIds = [
      ...new Set(fetched.map((w) => w.property_id as string)),
    ].filter((id) => force || !cachedPropertyIds.has(id))
    if (propertyIds.length) {
      const { data: properties } = await supabase
        .from('properties')
        .select('id, org_id, name, address, city, state, lat, lng, timezone')
        .in('id', propertyIds)
      if (properties?.length) await db.properties.bulkPut(properties as PropertyRow[])
    }
  }
  await advanceCursor(userId, 'cursor:work_orders', fetched as { updated_at?: string | null }[])
}
