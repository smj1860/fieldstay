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

export async function syncAssignedTurnovers(
  supabase: DexieSupabaseClient,
  userId: string,
  crewMemberId: string,
  force = false,
): Promise<void> {
  const db = getDexieDb(userId)

  // ── 1. Assignment scope: always a full pull ────────────────────────────
  const { data: assignments, error: assignError } = await supabase
    .from('turnover_assignments')
    .select('turnover_id')
    .eq('crew_member_id', crewMemberId)
  if (assignError) {
    console.error('[turnoverSync] turnover_assignments fetch failed:', assignError)
    return
  }

  const assignedIds: string[] = [
    ...new Set<string>((assignments ?? []).map((a: { turnover_id: string }) => a.turnover_id)),
  ]

  // ── 2. Reconcile deletions: unassigned turnovers leave the device ──────
  const localIds = new Set<string>(
    (await db.turnovers.toArray()).map((t) => t.id)
  )
  const assignedIdSet = new Set(assignedIds)
  const removedIds = [...localIds].filter((id) => !assignedIdSet.has(id))
  if (removedIds.length) {
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

  if (!assignedIds.length) return

  // ── 3. Turnover rows: delta for known ids, full for ids new to device ──
  const { known, fresh } = partitionByKnown(assignedIds, localIds)
  const cursor = force ? null : await getCursor(userId, 'cursor:turnovers')

  const fetched: Record<string, unknown>[] = []

  if (fresh.length || cursor === null) {
    // No cursor yet (or forced): one full pull of the whole scope
    const fullIds = cursor === null ? assignedIds : fresh
    const { data, error } = await supabase
      .from('turnovers')
      .select(TURNOVER_COLUMNS)
      .in('id', fullIds)
    if (error) {
      console.error('[turnoverSync] turnovers fetch failed:', error)
      return
    }
    fetched.push(...(data ?? []))
  }

  if (cursor !== null && known.length) {
    const { data, error } = await supabase
      .from('turnovers')
      .select(TURNOVER_COLUMNS)
      .in('id', known)
      .gt('updated_at', cursor)
    if (error) {
      console.error('[turnoverSync] turnovers delta fetch failed:', error)
      return
    }
    fetched.push(...(data ?? []))
  }

  if (fetched.length) {
    await db.turnovers.bulkPut(normalizeTurnovers(fetched))
  }
  await advanceCursor(userId, 'cursor:turnovers', fetched as { updated_at?: string | null }[])

  // ── 4. Reference data for the assigned scope ───────────────────────────
  // Properties: only fetch ids the device doesn't have yet (names/coords
  // rarely change; a full resync or reassignment refreshes them). Inventory
  // stays a full pull of the property scope — one bounded query.
  const scopeTurnovers = await db.turnovers.toArray()
  const propertyIds = [...new Set(scopeTurnovers.map((t) => t.property_id))]
  if (propertyIds.length) {
    const cachedPropertyIds = new Set(
      (await db.properties.toArray()).map((p) => p.id)
    )
    const missingPropertyIds = force
      ? propertyIds
      : propertyIds.filter((id) => !cachedPropertyIds.has(id))

    if (missingPropertyIds.length) {
      const { data: properties, error: pErr } = await supabase
        .from('properties')
        .select('id, org_id, name, address, city, state, lat, lng, timezone')
        .in('id', missingPropertyIds)
      if (pErr) {
        console.error('[turnoverSync] properties fetch failed:', pErr)
        return
      }
      if (properties?.length) await db.properties.bulkPut(properties as PropertyRow[])
    }

    const { data: inventory, error: invErr } = await supabase
      .from('inventory_items')
      .select('id, property_id, org_id, name, category, unit, par_level, current_quantity')
      .in('property_id', propertyIds)
      .eq('is_active', true)
    if (invErr) {
      console.error('[turnoverSync] inventory fetch failed:', invErr)
      return
    }
    if (inventory?.length) await db.inventory_items.bulkPut(inventory as InventoryItemRow[])
  }

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
    await db.checklist_instances.bulkPut(normalizedInstances as ChecklistInstanceRow[])
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
    const normalized = items.map((item) => {
      const { updated_at: _updatedAt, ...row } = item
      return {
        ...row,
        is_completed:          Number(row.is_completed ?? 0),
        requires_photo:        Number(row.requires_photo ?? 0),
        is_section_final_item: row.is_section_final_item !== null ? Number(row.is_section_final_item) : 0,
        completed_by_crew_id:  row.completed_by_crew_id ?? '',
        // Only retain crew_notes if this crew member authored them — nullify
        // notes from other crew members on multi-crew turnovers before they
        // land in this device's local cache.
        crew_notes:            row.completed_by_crew_id === thisCrewMemberId ? (row.crew_notes ?? '') : '',
        photo_reason:          row.photo_reason ?? '',
      }
    })
    await db.checklist_instance_items.bulkPut(normalized as ChecklistInstanceItemRow[])
  }
  if (opts.advanceCursors) {
    await advanceCursor(userId, 'cursor:checklist_items', items as { updated_at?: string | null }[])
  }
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
    const { data, error } = await supabase
      .from(table).select(columns).in(scopeColumn, fullIds)
    if (error) {
      console.error(`[turnoverSync] ${table} fetch failed:`, error)
      return null
    }
    rows.push(...((data ?? []) as unknown as Record<string, unknown>[]))
  }

  if (cursor !== null && knownIds.length) {
    const { data, error } = await supabase
      .from(table).select(columns).in(scopeColumn, knownIds).gt('updated_at', cursor)
    if (error) {
      console.error(`[turnoverSync] ${table} delta fetch failed:`, error)
      return null
    }
    rows.push(...((data ?? []) as unknown as Record<string, unknown>[]))
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

  const { data: turnovers, error } = await supabase
    .from('turnovers')
    .select(TURNOVER_COLUMNS)
    .in('id', turnoverIds)
  if (error) {
    console.error('[turnoverSync] turnovers re-fetch failed:', error)
    return
  }
  if (turnovers?.length) {
    await db.turnovers.bulkPut(normalizeTurnovers(turnovers as Record<string, unknown>[]))
  }
}
