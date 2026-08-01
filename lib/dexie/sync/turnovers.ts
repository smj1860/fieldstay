// lib/dexie/sync/turnovers.ts
//
// Pulls turnover_assignments → turnovers → properties/inventory into Dexie,
// plus the checklist pull that rides along with it. Extracted out of
// DexieProvider's mount effect (lib/dexie/context.tsx) — these are pure
// fetch-and-normalize functions with no dependency on the effect's
// subscription/channel state, so they're safe to call from anywhere that
// has a supabase client and userId in scope.
//
// Sync-v2 shape (crew sync Phase 1):
//  - turnover_assignments is ALWAYS a full pull of this crew member's rows.
//    The set is tiny (a handful of ids) and the full pull doubles as the
//    delete-detection mechanism: local turnovers whose id is no longer in
//    the assigned set get removed, together with their cached checklists.
//    (The old created_at watermark could only ever ADD turnovers — an
//    unassignment left the turnover on the device forever.)
//  - turnovers / checklist_instances / checklist_instance_items are pulled
//    with per-entity updated_at cursors (see ./cursors.ts): only rows that
//    changed since the last pull transfer. Ids that are NEW to this device
//    are always pulled without a cursor — their rows may be old, so a
//    delta filter would skip them.
//  - `force = true` bypasses every cursor (full row pull) without changing
//    the reconciliation behavior. Kept as an escape hatch for manual
//    refresh paths; routine mount/reconnect/event syncs use delta.

import type { DexieSupabaseClient } from './types'
import {
  getDexieDb,
  type TurnoverRow,
  type PropertyRow,
  type ChecklistInstanceRow,
  type ChecklistInstanceItemRow,
  type InventoryItemRow,
} from '../schema'
import { getCursor, advanceCursor, partitionByKnown } from './cursors'
import { fetchInChunks, fetchInChunksPaginated, IN_CHUNK_SIZE } from './chunked'
import { bulkPutShadowed } from './shadow'
import { reportError } from '@/lib/observability/report-error'

const TURNOVER_COLUMNS =
  'id, property_id, org_id, checkout_datetime, checkin_datetime, window_minutes, status, priority, notes, ' +
  'inventory_started_at, inventory_confirmed_complete_at, inventory_confirmed_by_crew_id, completion_notes, ' +
  'pending_checkout_datetime, pending_checkin_datetime, dates_changed_at, dates_change_acknowledged_at, updated_at'

function normalizeTurnovers(rows: Record<string, unknown>[]): TurnoverRow[] {
  return rows.map((t) => {
    // updated_at feeds the cursor only — keep the Dexie row shape unchanged
    const { updated_at: _updatedAt, ...row } = t
    return {
      ...row,
      inventory_confirmed_by_crew_id: row.inventory_confirmed_by_crew_id ?? '',
      completion_notes:               row.completion_notes ?? '',
    } as TurnoverRow
  })
}

/** Full pull of this crew member's assignment scope. Null on query failure. */
async function fetchAssignedTurnoverIds(
  supabase: DexieSupabaseClient,
  crewMemberId: string,
): Promise<string[] | null> {
  const { data, error } = await supabase
    .from('turnover_assignments')
    .select('turnover_id')
    .eq('crew_member_id', crewMemberId)
  if (error) {
    console.error('[turnoverSync] turnover_assignments fetch failed:', error)
    reportError(new Error(`turnover_assignments fetch failed: ${error.message}`), {
      site: 'dexie.sync.turnovers.assignments',
    })
    return null
  }
  return [...new Set<string>((data ?? []).map((a: { turnover_id: string }) => a.turnover_id))]
}

/**
 * Deletion/scope reconciliation: a turnover no longer in the assigned set
 * leaves the device together with its cached checklists. This — not the
 * cursor — is what makes unassignment correct (cursor invariant #1).
 */
async function reconcileRemovedTurnovers(
  userId: string,
  localIds: Set<string>,
  assignedIds: string[],
): Promise<void> {
  const db = getDexieDb(userId)
  const assignedIdSet = new Set(assignedIds)
  const removedIds = [...localIds].filter((id) => !assignedIdSet.has(id))
  if (!removedIds.length) return

  const instanceKeys = await db.checklist_instances
    .where('turnover_id').anyOf(removedIds).primaryKeys()
  const itemKeys = await db.checklist_instance_items
    .where('turnover_id').anyOf(removedIds).primaryKeys()
  await Promise.all([
    db.turnovers.bulkDelete(removedIds),
    db.checklist_instances.bulkDelete(instanceKeys),
    db.checklist_instance_items.bulkDelete(itemKeys),
  ])
}

/**
 * Turnover rows for the assigned scope: full pull for ids new to the device
 * (or when no cursor exists yet), delta pull for known ids. Null on failure
 * so the caller bails without advancing the cursor.
 */
async function fetchTurnoverRows(
  supabase: DexieSupabaseClient,
  assignedIds: string[],
  known: string[],
  fresh: string[],
  cursor: string | null,
): Promise<Record<string, unknown>[] | null> {
  const fetched: Record<string, unknown>[] = []

  if (fresh.length || cursor === null) {
    // No cursor yet (or forced): one full pull of the whole scope
    const fullIds = cursor === null ? assignedIds : fresh
    const data = await fetchInChunks<string, Record<string, unknown>>(fullIds, (chunk) =>
      supabase.from('turnovers').select(TURNOVER_COLUMNS).in('id', chunk).limit(IN_CHUNK_SIZE),
    )
    if (data === null) {
      console.error('[turnoverSync] turnovers fetch failed')
      reportError(new Error('turnovers fetch failed'), { site: 'dexie.sync.turnovers.full' })
      return null
    }
    fetched.push(...data)
  }

  if (cursor !== null && known.length) {
    const data = await fetchInChunks<string, Record<string, unknown>>(known, (chunk) =>
      supabase.from('turnovers').select(TURNOVER_COLUMNS).in('id', chunk).gt('updated_at', cursor).limit(IN_CHUNK_SIZE),
    )
    if (data === null) {
      console.error('[turnoverSync] turnovers delta fetch failed')
      reportError(new Error('turnovers delta fetch failed'), { site: 'dexie.sync.turnovers.delta' })
      return null
    }
    fetched.push(...data)
  }

  return fetched
}

/**
 * Reference data for the assigned property scope: properties (only ids the
 * device lacks — names/coords rarely change) and the full inventory set for
 * those properties. Returns false on a query failure so the caller stops.
 */
async function syncScopeReferenceData(
  supabase: DexieSupabaseClient,
  userId: string,
  force: boolean,
): Promise<boolean> {
  const db = getDexieDb(userId)
  const scopeTurnovers = await db.turnovers.toArray()
  const propertyIds = [...new Set(scopeTurnovers.map((t) => t.property_id))]
  if (!propertyIds.length) return true

  const cachedPropertyIds = new Set((await db.properties.toArray()).map((p) => p.id))
  const missingPropertyIds = force
    ? propertyIds
    : propertyIds.filter((id) => !cachedPropertyIds.has(id))

  if (missingPropertyIds.length) {
    const properties = await fetchInChunks(missingPropertyIds, (chunk) =>
      supabase
        .from('properties')
        .select('id, org_id, name, address, city, state, lat, lng, timezone')
        .in('id', chunk)
        .limit(IN_CHUNK_SIZE),
    )
    if (properties === null) {
      console.error('[turnoverSync] properties fetch failed')
      reportError(new Error('properties fetch failed'), { site: 'dexie.sync.turnovers.properties' })
      return false
    }
    if (properties.length) await db.properties.bulkPut(properties as PropertyRow[])
  }

  const inventory = await fetchInChunks(propertyIds, (chunk) =>
    supabase
      .from('inventory_items')
      .select('id, property_id, org_id, name, category, unit, par_level, current_quantity')
      .in('property_id', chunk)
      .eq('is_active', true),
  )
  if (inventory === null) {
    console.error('[turnoverSync] inventory fetch failed')
    reportError(new Error('inventory fetch failed'), { site: 'dexie.sync.turnovers.inventory' })
    return false
  }
  // Shadowed: a crew member's queued-but-unpushed count must not be reverted
  // in front of them by a routine pull.
  if (inventory.length) {
    await bulkPutShadowed(db.inventory_items, userId, 'inventory_items', inventory as InventoryItemRow[])
  }
  return true
}

export async function syncAssignedTurnovers(
  supabase: DexieSupabaseClient,
  userId: string,
  crewMemberId: string,
  force = false,
): Promise<void> {
  const db = getDexieDb(userId)

  // ── 1. Assignment scope: always a full pull ────────────────────────────
  const assignedIds = await fetchAssignedTurnoverIds(supabase, crewMemberId)
  if (assignedIds === null) return

  // ── 2. Reconcile deletions: unassigned turnovers leave the device ──────
  const localIds = new Set<string>((await db.turnovers.toArray()).map((t) => t.id))
  await reconcileRemovedTurnovers(userId, localIds, assignedIds)

  if (!assignedIds.length) return

  // ── 3. Turnover rows: delta for known ids, full for ids new to device ──
  const { known, fresh } = partitionByKnown(assignedIds, localIds)
  const cursor = force ? null : await getCursor(userId, 'cursor:turnovers')
  const fetched = await fetchTurnoverRows(supabase, assignedIds, known, fresh, cursor)
  if (fetched === null) return

  if (fetched.length) {
    await bulkPutShadowed(db.turnovers, userId, 'turnovers', normalizeTurnovers(fetched))
  }
  await advanceCursor(userId, 'cursor:turnovers', fetched as { updated_at?: string | null }[])

  // ── 4. Reference data for the assigned scope ───────────────────────────
  if (!(await syncScopeReferenceData(supabase, userId, force))) return

  // ── 5. Checklists ride along; fresh turnover ids skip the cursor ───────
  await pullChecklistsForTurnovers(supabase, userId, assignedIds, crewMemberId, {
    force,
    freshTurnoverIds: fresh,
    // This call covers the FULL assigned scope, so it's the one place the
    // checklist cursors may advance (see the advanceCursors note below).
    advanceCursors: true,
  })
}

// Pulls checklist_instances + checklist_instance_items for a given set of
// turnover ids, delta-filtered by per-entity cursors. Called both from
// syncAssignedTurnovers above and from the checklist Realtime subscription
// in context.tsx (a co-crew member's item tick bumps the row's updated_at,
// so the delta pull picks it up).
//
// opts.freshTurnoverIds: ids new to this device — always pulled in full,
// since their checklist rows can be older than the cursor.
//
// opts.advanceCursors: cursors may only advance from a pull that covered
// the FULL assigned scope (syncAssignedTurnovers). The Realtime handlers
// call this scoped to a single changed turnover — if that partial pull
// advanced the global cursor, a near-simultaneous change in a DIFFERENT
// turnover whose event was lost could end up older than the cursor and be
// skipped by every later delta. Defaults to false; partial pulls still
// delta-fetch efficiently, they just leave the cursor where it was (the
// few re-fetched rows on the next full-scope sync are idempotent puts).
export async function pullChecklistsForTurnovers(
  supabase: DexieSupabaseClient,
  userId: string,
  turnoverIds: string[],
  thisCrewMemberId: string,
  opts: { force?: boolean; freshTurnoverIds?: string[]; advanceCursors?: boolean } = {},
): Promise<void> {
  if (!turnoverIds.length) return
  const db = getDexieDb(userId)

  const freshSet = new Set(opts.freshTurnoverIds ?? [])
  const knownIds = turnoverIds.filter((id) => !freshSet.has(id))
  const freshIds = turnoverIds.filter((id) => freshSet.has(id))

  // ── Instances ────────────────────────────────────────────────────────
  const instanceCursor = opts.force ? null : await getCursor(userId, 'cursor:checklist_instances')
  const instances = await fetchWithCursorSplit(
    supabase, 'checklist_instances',
    'id, turnover_id, org_id, status, section_photo_path, started_at, completed_at, completed_by_crew_id, updated_at',
    'turnover_id', knownIds, freshIds, instanceCursor,
  )
  if (instances === null) return
  if (instances.length) {
    const normalizedInstances = instances.map((i) => {
      const { updated_at: _updatedAt, ...row } = i
      return { ...row, completed_by_crew_id: row.completed_by_crew_id ?? '' }
    })
    await bulkPutShadowed(db.checklist_instances, userId, 'checklist_instances', normalizedInstances as ChecklistInstanceRow[])
  }
  if (opts.advanceCursors) {
    await advanceCursor(userId, 'cursor:checklist_instances', instances as { updated_at?: string | null }[])
  }

  // ── Items ────────────────────────────────────────────────────────────
  // Queried by the denormalized turnover_id (not instance_id) so the item
  // delta is independent of whether any instance row changed this pull.
  const itemCursor = opts.force ? null : await getCursor(userId, 'cursor:checklist_items')
  const items = await fetchWithCursorSplit(
    supabase, 'checklist_instance_items',
    'id, instance_id, turnover_id, section_name, task, is_completed, completed_at, completed_by_crew_id, requires_photo, photo_reason, photo_storage_path, crew_notes, sort_order, is_section_final_item, updated_at',
    'turnover_id', knownIds, freshIds, itemCursor,
  )
  if (items === null) return
  if (items.length) {
    // Crew-note isolation needs the LOCAL row, not just the remote one:
    // checklist_instance_items has no note-author column, only
    // completed_by_crew_id. Keying isolation off that column alone leaked
    // another crew member's note text the moment this device completed the
    // item (completed_by_crew_id then equals this crew member, so their
    // note was adopted wholesale). A note is authored on-device and written
    // to Dexie first, so an already-cached item's local note is the
    // authoritative one for this device; a remote note is only ever adopted
    // for an item this device has never seen AND whose recorded crew member
    // is this one. Cost: a note this crew member wrote on a different device
    // won't back-fill onto an item already cached here — a freshness gap
    // within one crew member's own data, not a cross-crew leak.
    const localItems = await db.checklist_instance_items
      .where('id').anyOf(items.map((i) => i.id as string)).toArray()
    const localById = new Map(localItems.map((i) => [i.id, i]))

    const normalized = items.map((item) => {
      const { updated_at: _updatedAt, ...row } = item
      return {
        ...row,
        is_completed:          Number(row.is_completed ?? 0),
        requires_photo:        Number(row.requires_photo ?? 0),
        is_section_final_item: row.is_section_final_item !== null ? Number(row.is_section_final_item) : 0,
        completed_by_crew_id:  row.completed_by_crew_id ?? '',
        crew_notes:            resolveCrewNotes(row, localById.get(row.id as string), thisCrewMemberId),
        photo_reason:          row.photo_reason ?? '',
      }
    })
    await bulkPutShadowed(db.checklist_instance_items, userId, 'checklist_instance_items', normalized as ChecklistInstanceItemRow[])
  }
  if (opts.advanceCursors) {
    await advanceCursor(userId, 'cursor:checklist_items', items as { updated_at?: string | null }[])
  }
}

// See the isolation comment at the call site: local note wins for an
// already-cached item; a remote note is adopted only for an item this device
// has never seen and only when this crew member is the recorded actor.
function resolveCrewNotes(
  remote: Record<string, unknown>,
  local: ChecklistInstanceItemRow | undefined,
  thisCrewMemberId: string,
): string {
  if (local !== undefined) return local.crew_notes ?? ''
  return remote.completed_by_crew_id === thisCrewMemberId ? ((remote.crew_notes as string | null) ?? '') : ''
}

// Shared fetch shape for the two checklist pulls: full pull for ids new to
// the device (or when no cursor exists yet), delta pull for known ids.
// Returns null on a query error (after logging) so callers bail without
// advancing cursors.
async function fetchWithCursorSplit(
  supabase: DexieSupabaseClient,
  table: 'checklist_instances' | 'checklist_instance_items',
  columns: string,
  scopeColumn: string,
  knownIds: string[],
  freshIds: string[],
  cursor: string | null,
): Promise<Record<string, unknown>[] | null> {
  const rows: Record<string, unknown>[] = []

  const fullIds = cursor === null ? [...knownIds, ...freshIds] : freshIds
  if (fullIds.length) {
    // Paginated per chunk: scopeColumn is turnover_id, a ONE-TO-MANY scope, so
    // chunking the id list does not bound the row count (see
    // fetchInChunksPaginated). 100 turnovers x 30-60 checklist items is well
    // past PostgREST's 1000-row cap.
    const data = await fetchInChunksPaginated(fullIds, (chunk, from, to) =>
      supabase.from(table).select(columns).in(scopeColumn, chunk)
        .order('id').range(from, to),
    )
    if (data === null) {
      console.error(`[turnoverSync] ${table} fetch failed`)
      reportError(new Error(`${table} fetch failed`), { site: 'dexie.sync.turnovers.checklist_full' })
      return null
    }
    rows.push(...(data as unknown as Record<string, unknown>[]))
  }

  if (cursor !== null && knownIds.length) {
    const data = await fetchInChunksPaginated(knownIds, (chunk, from, to) =>
      supabase.from(table).select(columns).in(scopeColumn, chunk).gt('updated_at', cursor)
        .order('id').range(from, to),
    )
    if (data === null) {
      console.error(`[turnoverSync] ${table} delta fetch failed`)
      reportError(new Error(`${table} delta fetch failed`), { site: 'dexie.sync.turnovers.checklist_delta' })
      return null
    }
    rows.push(...(data as unknown as Record<string, unknown>[]))
  }

  return rows
}

// Re-fetches just the turnovers rows themselves (status, inventory
// confirmation fields) — separate from pullChecklistsForTurnovers, which
// never touches the turnovers table. Needed so one crew member's "Confirm
// Inventory Complete" tap (or the resulting auto-completion) shows up live
// on the other crew member's device. Always a direct id-scoped pull — the
// caller already knows exactly which rows changed, so no cursor applies,
// and (being a partial-scope pull) it never advances the turnover cursor.
export async function pullTurnoversOnly(
  supabase: DexieSupabaseClient,
  userId: string,
  turnoverIds: string[],
): Promise<void> {
  if (!turnoverIds.length) return
  const db = getDexieDb(userId)

  const turnovers = await fetchInChunks(turnoverIds, (chunk) =>
    supabase.from('turnovers').select(TURNOVER_COLUMNS).in('id', chunk).limit(IN_CHUNK_SIZE),
  )
  if (turnovers === null) {
    console.error('[turnoverSync] turnovers re-fetch failed')
    reportError(new Error('turnovers re-fetch failed'), { site: 'dexie.sync.turnovers.refetch' })
    return
  }
  if (turnovers.length) {
    await bulkPutShadowed(db.turnovers, userId, 'turnovers', normalizeTurnovers(turnovers as Record<string, unknown>[]))
  }
}
