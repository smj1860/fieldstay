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
import { getDexieDb, type CrewWorkOrderRow, type PropertyRow, type FieldStayDexie } from '../schema'
import { getCursor, advanceCursor } from './cursors'
import { fetchInChunks, IN_CHUNK_SIZE } from './chunked'
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
 * Membership snapshot: the id set the crew member currently has open. This —
 * never the cursor — is what decides membership, because a delta can only
 * report rows that still MATCH its filter.
 */
async function idSnapshot(
  supabase: DexieSupabaseClient,
  crewMemberId: string,
  twoWeeksAgo: string,
): Promise<Set<string> | null> {
  const { data, error } = await supabase
    .from('work_orders')
    .select('id')
    .eq('assigned_crew_member_id', crewMemberId)
    .not('status', 'in', '("completed","cancelled")')
    .or(`scheduled_date.is.null,scheduled_date.gte.${twoWeeksAgo}`)
  if (error) {
    console.error('[work-orders sync] work_orders id snapshot failed:', error)
    return null
  }
  return new Set(((data ?? []) as { id: string }[]).map((w) => w.id))
}

/**
 * Delta pull WITHOUT the status filter, so a work order that closed since the
 * cursor comes back carrying its new status and can be removed locally — a
 * tombstone rather than a silent disappearance.
 *
 * That is what lets the routine pass cost ONE query instead of two. The old
 * delta excluded completed/cancelled, so a closed WO simply stopped matching
 * and only the id snapshot could notice; running that snapshot on every
 * five-minute tick made work_orders the most expensive cursored entity in the
 * crew sync, despite being the only one with a broadcast trigger to lean on.
 *
 * The case a tombstone still cannot cover is reassignment AWAY: the row stops
 * matching `assigned_crew_member_id`, so it is not returned at all. That is
 * what `reconcile` is for — see syncWorkOrders.
 */
async function deltaPull(
  supabase: DexieSupabaseClient,
  crewMemberId: string,
  cursor: string,
): Promise<Record<string, unknown>[] | null> {
  const { data, error } = await supabase
    .from('work_orders')
    .select(WO_COLUMNS)
    .eq('assigned_crew_member_id', crewMemberId)
    .gt('updated_at', cursor)
  if (error) {
    console.error('[work-orders sync] work_orders delta fetch failed:', error)
    return null
  }
  return (data ?? []) as Record<string, unknown>[]
}

/** Statuses that take a work order off the crew member's plate. */
const CLOSED_STATUSES = new Set(['completed', 'cancelled'])

/**
 * What a pull decided: rows to cache, rows the cursor should advance from
 * (tombstones included), and ids that must leave the device.
 */
interface WoResolution {
  fetched:     Record<string, unknown>[]
  seen:        Record<string, unknown>[]
  departedIds: Set<string>
}

/** First pull, or a forced one: the data fetch doubles as the membership snapshot. */
async function resolveFullPull(
  db: FieldStayDexie,
  scoped: ScopedQuery,
): Promise<WoResolution | null> {
  const pulled = await fullPull(scoped)
  if (pulled === null) return null

  const cached = (await db.crew_work_orders.toArray()).map((w) => w.id)
  return {
    fetched:     pulled.fetched,
    seen:        pulled.fetched,
    departedIds: new Set(cached.filter((id) => !pulled.currentIds.has(id))),
  }
}

/**
 * Routine pull: one delta query, with closed work orders arriving as
 * tombstones rather than silently ceasing to match.
 *
 * `reconcile` adds the membership snapshot, which is only needed for
 * reassignment AWAY — the one departure a delta cannot see, because the row
 * stops matching assigned_crew_member_id and is not returned at all. The
 * broadcast trigger notifies both the previous and the new assignee when that
 * happens, so the signal path normally covers it; this is the backstop that
 * keeps correctness from depending on a broadcast having arrived.
 */
async function resolveDeltaPull(
  supabase: DexieSupabaseClient,
  db: FieldStayDexie,
  crewMemberId: string,
  twoWeeksAgo: string,
  cursor: string,
  reconcile: boolean,
): Promise<WoResolution | null> {
  const delta = await deltaPull(supabase, crewMemberId, cursor)
  if (delta === null) return null

  const isClosed = (w: Record<string, unknown>) => CLOSED_STATUSES.has(w.status as string)
  const departedIds = new Set(delta.filter(isClosed).map((w) => w.id as string))

  if (reconcile) {
    const currentIds = await idSnapshot(supabase, crewMemberId, twoWeeksAgo)
    if (currentIds === null) return null
    for (const w of await db.crew_work_orders.toArray()) {
      if (!currentIds.has(w.id)) departedIds.add(w.id)
    }
  }

  return { fetched: delta.filter((w) => !isClosed(w)), seen: delta, departedIds }
}

export async function syncWorkOrders(
  supabase: DexieSupabaseClient,
  userId: string,
  crewMemberId: string,
  force = false,
  reconcile = false,
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

  const resolved = cursor === null
    ? await resolveFullPull(db, scoped)
    : await resolveDeltaPull(supabase, db, crewMemberId, twoWeeksAgo, cursor, reconcile)
  if (resolved === null) return
  const { fetched, seen, departedIds } = resolved

  if (departedIds.size) {
    await db.crew_work_orders.bulkDelete([...departedIds])
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
          .in('id', chunk)
          .limit(IN_CHUNK_SIZE),
      )
      if (properties === null) {
        console.error('[work-orders sync] properties fetch failed')
        reportError(new Error('properties fetch failed'), { site: 'dexie.sync.work_orders.properties' })
        return
      }
      if (properties.length) await db.properties.bulkPut(properties as PropertyRow[])
    }
  }
  await advanceCursor(userId, 'cursor:work_orders', seen as { updated_at?: string | null }[])
}
