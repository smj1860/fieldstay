// lib/dexie/sync/turnovers.ts
//
// Pulls turnover_assignments → turnovers → properties/inventory into Dexie,
// plus the checklist pull that rides along with it. Extracted out of
// DexieProvider's mount effect (lib/dexie/context.tsx) — these are pure
// fetch-and-normalize functions with no dependency on the effect's
// subscription/channel state, so they're safe to call from anywhere that
// has a supabase client and userId in scope.

import type { DexieSupabaseClient } from './types'
import {
  getDexieDb,
  type TurnoverRow,
  type PropertyRow,
  type ChecklistInstanceRow,
  type ChecklistInstanceItemRow,
  type InventoryItemRow,
} from '../schema'

export async function syncAssignedTurnovers(
  supabase: DexieSupabaseClient,
  userId: string,
  crewMemberId: string,
  force = false,
): Promise<void> {
  const db = getDexieDb(userId)
  const watermark = await db.sync_meta.get('turnover_assignments_synced_at')

  // force=true on initial mount — full pull regardless of watermark.
  // Protects against a stale/premature watermark locking out existing assignments.
  const since = force ? null : (watermark?.value ?? null)
  const syncStartedAt = new Date().toISOString()

  let query = supabase
    .from('turnover_assignments')
    .select('turnover_id, created_at')
    .eq('crew_member_id', crewMemberId)
  if (since) query = query.gt('created_at', since)

  const { data: assignments, error: assignError } = await query
  if (assignError) {
    console.error('[turnoverSync] turnover_assignments fetch failed:', assignError)
    return
  }

  const turnoverIds: string[] = [
    ...new Set<string>((assignments ?? []).map((a: { turnover_id: string }) => a.turnover_id)),
  ]

  if (!turnoverIds.length) {
    // Only advance watermark on a full pull (no since filter).
    // Incremental pull with zero new results is a no-op — don't move the cursor.
    if (!since) {
      await db.sync_meta.put({ key: 'turnover_assignments_synced_at', value: syncStartedAt })
    }
    return
  }

  const { data: turnovers, error: tErr } = await supabase
    .from('turnovers')
    .select(
      'id, property_id, org_id, checkout_datetime, checkin_datetime, window_minutes, status, priority, notes, ' +
      'inventory_started_at, inventory_confirmed_complete_at, inventory_confirmed_by_crew_id, completion_notes, ' +
      'pending_checkout_datetime, pending_checkin_datetime, dates_changed_at, dates_change_acknowledged_at'
    )
    .in('id', turnoverIds)
  if (tErr) {
    console.error('[turnoverSync] turnovers fetch failed:', tErr)
    return
  }
  if (turnovers?.length) {
    const normalizedTurnovers = turnovers.map((t: Record<string, unknown>) => ({
      ...t,
      inventory_confirmed_by_crew_id: t.inventory_confirmed_by_crew_id ?? '',
      completion_notes:               t.completion_notes ?? '',
    }))
    await db.turnovers.bulkPut(normalizedTurnovers as TurnoverRow[])
  }

  const propertyIds = [
    ...new Set((turnovers ?? []).map((t: { property_id: string }) => t.property_id)),
  ]
  if (propertyIds.length) {
    const { data: properties, error: pErr } = await supabase
      .from('properties')
      .select('id, org_id, name, address, city, state, lat, lng, timezone')
      .in('id', propertyIds)
    if (pErr) {
      console.error('[turnoverSync] properties fetch failed:', pErr)
      return
    }
    if (properties?.length) await db.properties.bulkPut(properties as PropertyRow[])

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

  await pullChecklistsForTurnovers(supabase, userId, turnoverIds, crewMemberId)

  // Only advance watermark after everything landed successfully
  await db.sync_meta.put({ key: 'turnover_assignments_synced_at', value: syncStartedAt })
}

// Pulls checklist_instances + checklist_instance_items for a given set of
// turnover ids. Always a full re-pull (no watermark) — called both from
// syncAssignedTurnovers above and from the checklist Realtime subscription
// in context.tsx, since a checklist item completing doesn't touch
// turnover_assignments at all, so the assignment watermark has nothing to
// key off of for that case.
export async function pullChecklistsForTurnovers(
  supabase: DexieSupabaseClient,
  userId: string,
  turnoverIds: string[],
  thisCrewMemberId: string,
): Promise<void> {
  if (!turnoverIds.length) return
  const db = getDexieDb(userId)

  const { data: instances, error: ciErr } = await supabase
    .from('checklist_instances')
    .select('id, turnover_id, org_id, status, section_photo_path, started_at, completed_at, completed_by_crew_id')
    .in('turnover_id', turnoverIds)
  if (ciErr) {
    console.error('[turnoverSync] checklist_instances fetch failed:', ciErr)
    return
  }
  if (instances?.length) {
    const normalizedInstances = instances.map((i: Record<string, unknown>) => ({
      ...i,
      completed_by_crew_id: i.completed_by_crew_id ?? '',
    }))
    await db.checklist_instances.bulkPut(normalizedInstances as ChecklistInstanceRow[])
  }
  if (!instances?.length) return

  const instanceIds = instances.map((i: { id: string }) => i.id)
  const { data: items, error: itemErr } = await supabase
    .from('checklist_instance_items')
    .select('id, instance_id, turnover_id, section_name, task, is_completed, completed_at, completed_by_crew_id, requires_photo, photo_reason, photo_storage_path, crew_notes, sort_order, is_section_final_item')
    .in('instance_id', instanceIds)
  if (itemErr) {
    console.error('[turnoverSync] checklist_instance_items fetch failed:', itemErr)
    return
  }
  if (items?.length) {
    const normalized = items.map((item: Record<string, unknown>) => ({
      ...item,
      is_completed:          Number(item.is_completed ?? 0),
      requires_photo:        Number(item.requires_photo ?? 0),
      is_section_final_item: item.is_section_final_item !== null ? Number(item.is_section_final_item) : 0,
      completed_by_crew_id:  item.completed_by_crew_id ?? '',
      // Only retain crew_notes if this crew member authored them — nullify
      // notes from other crew members on multi-crew turnovers before they
      // land in this device's local cache.
      crew_notes:            item.completed_by_crew_id === thisCrewMemberId ? (item.crew_notes ?? '') : '',
      photo_reason:          item.photo_reason ?? '',
    }))
    await db.checklist_instance_items.bulkPut(normalized as ChecklistInstanceItemRow[])
  }
}

// Re-fetches just the turnovers rows themselves (status, inventory
// confirmation fields) — separate from pullChecklistsForTurnovers, which
// never touches the turnovers table. Needed so one crew member's "Confirm
// Inventory Complete" tap (or the resulting auto-completion) shows up live
// on the other crew member's device.
export async function pullTurnoversOnly(
  supabase: DexieSupabaseClient,
  userId: string,
  turnoverIds: string[],
): Promise<void> {
  if (!turnoverIds.length) return
  const db = getDexieDb(userId)

  const { data: turnovers, error } = await supabase
    .from('turnovers')
    .select(
      'id, property_id, org_id, checkout_datetime, checkin_datetime, window_minutes, status, priority, notes, ' +
      'inventory_started_at, inventory_confirmed_complete_at, inventory_confirmed_by_crew_id, completion_notes, ' +
      'pending_checkout_datetime, pending_checkin_datetime, dates_changed_at, dates_change_acknowledged_at'
    )
    .in('id', turnoverIds)
  if (error) {
    console.error('[turnoverSync] turnovers re-fetch failed:', error)
    return
  }
  if (turnovers?.length) {
    const normalized = turnovers.map((t: Record<string, unknown>) => ({
      ...t,
      inventory_confirmed_by_crew_id: t.inventory_confirmed_by_crew_id ?? '',
      completion_notes:               t.completion_notes ?? '',
    }))
    await db.turnovers.bulkPut(normalized as TurnoverRow[])
  }
}
