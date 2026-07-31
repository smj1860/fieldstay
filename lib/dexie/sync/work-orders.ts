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
import { fetchInChunks } from './chunked'
import { bulkPutShadowed } from './shadow'
import { reportError } from '@/lib/observability/report-error'

const WO_COLUMNS =
  'id, org_id, property_id, assigned_crew_member_id, title, description, ' +
  'status, priority, scheduled_date, wo_number, created_at, updated_at'


interface WoPull { fetched: Record<string, unknown>[]; currentIds: Set<string> }
type ScopedQuery = () => PromiseLike<{ data: unknown; error: unknown }>

/** Full pull: the data fetch doubles as the membership snapshot. */
async function fullPull(scoped: ScopedQuery): Promise<WoPull | null> {
  const { data, error } = await scoped()
  if (error) {
    console.error('[work-orders sync] work_orders fetch failed:', error)
    return null
  }
  const fetched = (data ?? []) as Record<string, unknown>[]
  return { fetched, currentIds: new Set(fetched.map((w) => w.id as string)) }
}

/**
 * Delta pull: an id-only membership snapshot (the reconciliation mechanism —
 * cursors are a bandwidth optimization and must never decide membership)
 * plus only the rows that changed since the cursor.
 */
async function deltaPull(
  supabase: DexieSupabaseClient,
  scoped: () => { gt: (col: string, v: string) => PromiseLike<{ data: unknown; error: unknown }> },
  crewMemberId: string,
  twoWeeksAgo: string,
  cursor: string,
): Promise<WoPull | null> {
  const { data: idRows, error: idError } = await supabase
    .from('work_orders')
    .select('id')
    .eq('assigned_crew_member_id', crewMemberId)
    .not('status', 'in', '("completed","cancelled")')
    .or(`scheduled_date.is.null,scheduled_date.gte.${twoWeeksAgo}`)
  if (idError) {
    console.error('[work-orders sync] work_orders id snapshot failed:', idError)
    return null
  }
  const currentIds = new Set(((idRows ?? []) as { id: string }[]).map((w) => w.id))

  const { data, error } = await scoped().gt('updated_at', cursor)
  if (error) {
    console.error('[work-orders sync] work_orders delta fetch failed:', error)
    return null
  }
  return { fetched: (data ?? []) as Record<string, unknown>[], currentIds }
}

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

  const pulled = cursor === null
    ? await fullPull(scoped)
    : await deltaPull(supabase, scoped, crewMemberId, twoWeeksAgo, cursor)
  if (pulled === null) return
  const { fetched, currentIds } = pulled

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
    // Shadowed: a queued-but-unpushed local completion must not be reverted
    // by a routine pull that still sees the WO as open server-side.
    await bulkPutShadowed(db.crew_work_orders, userId, 'crew_work_orders', rows as unknown as CrewWorkOrderRow[])

    // Ensure the properties referenced by these WOs are cached too, so the
    // crew home page and detail view can render names/addresses. Only ids
    // the device doesn't already have — reference data, rarely changes.
    const cachedPropertyIds = new Set((await db.properties.toArray()).map((p) => p.id))
    const propertyIds = [
      ...new Set(fetched.map((w) => w.property_id as string)),
    ].filter((id) => force || !cachedPropertyIds.has(id))
    if (propertyIds.length) {
      const properties = await fetchInChunks(propertyIds, (chunk) =>
        supabase
          .from('properties')
          .select('id, org_id, name, address, city, state, lat, lng, timezone')
          .in('id', chunk),
      )
      if (properties === null) {
        console.error('[work-orders sync] properties fetch failed')
        reportError(new Error('properties fetch failed'), { site: 'dexie.sync.work_orders.properties' })
        return
      }
      if (properties.length) await db.properties.bulkPut(properties as PropertyRow[])
    }
  }
  await advanceCursor(userId, 'cursor:work_orders', fetched as { updated_at?: string | null }[])
}
