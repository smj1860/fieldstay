'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AuthChangeEvent, Session, RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import {
  getDexieDb,
  cleanupStaleDexieDbs,
  type FieldStayDexie,
  type TurnoverRow,
  type PropertyRow,
  type ChecklistInstanceRow,
  type ChecklistInstanceItemRow,
  type InventoryItemRow,
  type MessageRow,
  type CrewWorkOrderRow,
  type CrewAvailabilityRow,
  type PropertyAssetRow,
} from './schema'

interface DexieContextValue {
  db:           FieldStayDexie | null
  userId:       string | null
  crewMemberId: string | null
}

const DexieContext = createContext<DexieContextValue>({ db: null, userId: null, crewMemberId: null })

/**
 * Mirrors PowerSyncContext.Provider in app/crew/crew-shell.tsx: resolves the
 * active user's session the same way SupabaseConnector.fetchCredentials()
 * does in lib/powersync/client.ts (gracefully returning null rather than
 * throwing when there's no session yet), then hands the per-user Dexie
 * instance down through context.
 *
 * If the caller already knows the user id (e.g. a server-rendered layout
 * that called `auth.getUser()` and passed it down as a prop, as
 * app/crew/layout.tsx does), pass it as `userId` to make it available
 * synchronously on first render — otherwise descendants briefly see no db
 * while the client-side session resolves asynchronously.
 */
export function DexieProvider({ userId: userIdProp, children }: { userId?: string; children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(userIdProp ?? null)
  const [crewMemberId, setCrewMemberId] = useState<string | null>(null)

  // Sync a userIdProp change into state during render rather than in an
  // effect, so the update lands in the same render pass as the prop change.
  const [prevUserIdProp, setPrevUserIdProp] = useState(userIdProp)
  if (userIdProp !== prevUserIdProp) {
    setPrevUserIdProp(userIdProp)
    if (userIdProp) setUserId(userIdProp)
  }

  useEffect(() => {
    if (userIdProp) return // parent already supplied the id — no need to resolve/subscribe

    const supabase = createClient()

    async function resolveSession() {
      const { data: { session } } = await supabase.auth.getSession()
      setUserId(session?.user.id ?? null)
    }

    resolveSession()

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
        setUserId(session?.user.id ?? null)
      }
    )

    return () => subscription.subscription.unsubscribe()
  }, [userIdProp])

  // Flush the outbox whenever the device comes back online — mirrors
  // crew-shell.tsx's 'online' listener for processPendingPhotoUploads.
  useEffect(() => {
    if (!userId) return

    // Clean up databases from previous users on this device (non-blocking)
    void cleanupStaleDexieDbs(userId)

    const supabase = createClient()
    let cancelled = false

    async function syncAssignedTurnovers(
      crewMemberId: string,
      force = false,
    ): Promise<void> {
      const db = getDexieDb(userId!)
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
        console.error('[DexieProvider] turnover_assignments fetch failed:', assignError)
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
        console.error('[DexieProvider] turnovers fetch failed:', tErr)
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
          console.error('[DexieProvider] properties fetch failed:', pErr)
          return
        }
        if (properties?.length) await db.properties.bulkPut(properties as PropertyRow[])

        const { data: inventory, error: invErr } = await supabase
          .from('inventory_items')
          .select('id, property_id, org_id, name, category, unit, par_level, current_quantity')
          .in('property_id', propertyIds)
          .eq('is_active', true)
        if (invErr) {
          console.error('[DexieProvider] inventory fetch failed:', invErr)
          return
        }
        if (inventory?.length) await db.inventory_items.bulkPut(inventory as InventoryItemRow[])
      }

      await pullChecklistsForTurnovers(turnoverIds, crewMemberId)

      // Only advance watermark after everything landed successfully
      await db.sync_meta.put({ key: 'turnover_assignments_synced_at', value: syncStartedAt })
    }

    // Pulls checklist_instances + checklist_instance_items for a given set
    // of turnover ids. Always a full re-pull (no watermark) — called both
    // from the assignment-driven sync above and from the checklist
    // Realtime subscription below, since a checklist item completing
    // doesn't touch turnover_assignments at all, so the assignment
    // watermark has nothing to key off of for that case.
    async function pullChecklistsForTurnovers(
      turnoverIds: string[],
      thisCrewMemberId: string,
    ): Promise<void> {
      if (!turnoverIds.length) return
      const db = getDexieDb(userId!)

      const { data: instances, error: ciErr } = await supabase
        .from('checklist_instances')
        .select('id, turnover_id, org_id, status, section_photo_path, started_at, completed_at, completed_by_crew_id')
        .in('turnover_id', turnoverIds)
      if (ciErr) {
        console.error('[DexieProvider] checklist_instances fetch failed:', ciErr)
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
        console.error('[DexieProvider] checklist_instance_items fetch failed:', itemErr)
        return
      }
      if (items?.length) {
        const normalized = items.map((item: Record<string, unknown>) => ({
          ...item,
          is_completed:          Number(item.is_completed ?? 0),
          requires_photo:        Number(item.requires_photo ?? 0),
          is_section_final_item: item.is_section_final_item !== null ? Number(item.is_section_final_item) : 0,
          completed_by_crew_id:  item.completed_by_crew_id ?? '',
          // Only retain crew_notes if this crew member authored them —
          // nullify notes from other crew members on multi-crew turnovers
          // before they land in this device's local cache.
          crew_notes:            item.completed_by_crew_id === thisCrewMemberId ? (item.crew_notes ?? '') : '',
          photo_reason:          item.photo_reason ?? '',
        }))
        await db.checklist_instance_items.bulkPut(normalized as ChecklistInstanceItemRow[])
      }
    }

    // Re-fetches just the turnovers rows themselves (status, inventory
    // confirmation fields) — separate from pullChecklistsForTurnovers,
    // which never touches the turnovers table. Needed so one crew member's
    // "Confirm Inventory Complete" tap (or the resulting auto-completion)
    // shows up live on the other crew member's device.
    async function pullTurnoversOnly(turnoverIds: string[]): Promise<void> {
      if (!turnoverIds.length) return
      const db = getDexieDb(userId!)

      const { data: turnovers, error } = await supabase
        .from('turnovers')
        .select(
          'id, property_id, org_id, checkout_datetime, checkin_datetime, window_minutes, status, priority, notes, ' +
          'inventory_started_at, inventory_confirmed_complete_at, inventory_confirmed_by_crew_id, completion_notes, ' +
          'pending_checkout_datetime, pending_checkin_datetime, dates_changed_at, dates_change_acknowledged_at'
        )
        .in('id', turnoverIds)
      if (error) {
        console.error('[DexieProvider] turnovers re-fetch failed:', error)
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

    // Refreshes the Realtime subscription covering checklist_instance_items,
    // checklist_instances, and turnovers changes to exactly the crew
    // member's currently-open turnovers — so both crew members see each
    // other's checklist item ticks, "Confirm Checklist/Inventory Complete"
    // taps, and the resulting turnover auto-completion live. Reads the
    // local Dexie cache (already kept current by syncAssignedTurnovers)
    // rather than re-deriving from a possibly-incremental assignment
    // fetch, so it always reflects the full set, not just newly-added
    // turnovers.
    //
    // Guarded by a generation token: this can be invoked concurrently by
    // rapid-fire turnover_assignments change events, each awaiting its own
    // db.turnovers.toArray() before touching the shared checklistChannel /
    // subscribedTurnoverIds vars. Without the token, an older call whose
    // await happens to resolve after a newer call's could overwrite the
    // newer (correct) subscription with its own stale turnover set — the
    // token lets a call detect it's been superseded and bail before
    // touching shared state, so only the most recently STARTED call's
    // result is ever committed.
    async function refreshChecklistSubscription(thisCrewMemberId: string): Promise<void> {
      const myGeneration = ++checklistRefreshGeneration
      const db = getDexieDb(userId!)
      const allTurnovers = await db.turnovers.toArray()
      if (myGeneration !== checklistRefreshGeneration) return // superseded by a newer call while awaiting

      const turnoverIds = allTurnovers
        .filter((t) => t.status !== 'completed' && t.status !== 'cancelled')
        .map((t) => t.id)

      const sameSet = turnoverIds.length === subscribedTurnoverIds.length
        && turnoverIds.every((id) => subscribedTurnoverIds.includes(id))
      if (sameSet) return

      if (checklistChannel) {
        supabase.removeChannel(checklistChannel)
        checklistChannel = null
      }
      subscribedTurnoverIds = turnoverIds
      if (!turnoverIds.length) return

      const filter = `turnover_id=in.(${turnoverIds.join(',')})`

      checklistChannel = supabase
        .channel(`checklist-items-${thisCrewMemberId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'checklist_instance_items', filter },
          (payload: RealtimePostgresChangesPayload<ChecklistInstanceItemRow>) => {
            // Scope the refetch to just the turnover that actually changed
            // instead of every open turnover — checklist_instance_items has
            // turnover_id denormalized onto it specifically for this (see
            // 20260611071742_checklist_instance_items_turnover_id_denorm.sql).
            // Falls back to the full set if the payload doesn't carry it —
            // e.g. a DELETE under the table's default (non-FULL) REPLICA
            // IDENTITY only guarantees the primary key on `old`, not every
            // column, so `old.turnover_id` may legitimately be absent there.
            // This table is effectively insert-once/update-only in practice
            // (items are seeded, never deleted), so that fallback path is a
            // safety net, not the common case.
            const changedTurnoverId =
              (payload.new as Partial<ChecklistInstanceItemRow>).turnover_id
              ?? (payload.old as Partial<ChecklistInstanceItemRow>).turnover_id
            void pullChecklistsForTurnovers(
              changedTurnoverId ? [changedTurnoverId] : subscribedTurnoverIds,
              thisCrewMemberId,
            )
          }
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'checklist_instances', filter },
          (payload: RealtimePostgresChangesPayload<ChecklistInstanceRow>) => {
            const changedTurnoverId =
              (payload.new as Partial<ChecklistInstanceRow>).turnover_id
              ?? (payload.old as Partial<ChecklistInstanceRow>).turnover_id
            void pullChecklistsForTurnovers(
              changedTurnoverId ? [changedTurnoverId] : subscribedTurnoverIds,
              thisCrewMemberId,
            )
          }
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'turnovers', filter: `id=in.(${turnoverIds.join(',')})` },
          (payload: RealtimePostgresChangesPayload<TurnoverRow>) => {
            const changedId =
              (payload.new as Partial<TurnoverRow>).id
              ?? (payload.old as Partial<TurnoverRow>).id
            void pullTurnoversOnly(changedId ? [changedId] : subscribedTurnoverIds)
          }
        )
        .subscribe()
    }

    async function syncWorkOrders(crewMemberId: string): Promise<void> {
      const db = getDexieDb(userId!)
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
        console.error('[DexieProvider] work_orders fetch failed:', error)
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

    async function syncMessages(): Promise<void> {
      const db = getDexieDb(userId!)
      const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString()
      const { data: messages } = await supabase
        .from('messages')
        .select('id, org_id, sender_id, recipient_id, content, read_at, turnover_id, group_id, group_label, created_at')
        .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
        .gte('created_at', ninetyDaysAgo)
        .order('created_at', { ascending: false })  // newest first — limit drops oldest not newest
        .limit(500)
      if (messages?.length) await db.messages.bulkPut(messages as MessageRow[])
    }

    async function syncCrewAvailability(crewMemberId: string): Promise<void> {
      const db = getDexieDb(userId!)

      // Only fetch this crew member's own availability — not other crew members'.
      // Tenant isolation: org_id is implicitly enforced via crew_member_id FK.
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().split('T')[0]!
      const oneYearAhead  = new Date(Date.now() + 365 * 86_400_000).toISOString().split('T')[0]!

      const { data: availability, error } = await supabase
        .from('crew_availability')
        .select('id, org_id, crew_member_id, available_date, is_available, notes, created_at')
        .eq('crew_member_id', crewMemberId)  // own rows only — critical isolation guard
        .gte('available_date', thirtyDaysAgo)
        .lte('available_date', oneYearAhead)
        .order('available_date', { ascending: true })
      if (error) {
        console.error('[DexieProvider] crew_availability fetch failed:', error)
        return
      }

      if (availability?.length) {
        const normalized = availability.map((row: Record<string, unknown>) => ({
          ...row,
          is_available: row.is_available ? 1 : 0,
          notes:        row.notes ?? '',
        }))
        await db.crew_availability.bulkPut(normalized as CrewAvailabilityRow[])
      }
    }

    // Properties this crew member currently has a stake in — same derivation
    // as assignedPropertyIds in app/crew/page.tsx (active turnovers ∪
    // assigned work orders) — backs the Assets & Maintenance page's
    // per-property missing-items list.
    async function computeAssignedPropertyIds(): Promise<string[]> {
      const db = getDexieDb(userId!)
      const [turnoverRows, woRows] = await Promise.all([
        db.turnovers.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').toArray(),
        db.crew_work_orders.filter((wo) => wo.status !== 'completed' && wo.status !== 'cancelled').toArray(),
      ])
      const ids = new Set<string>([
        ...turnoverRows.map((t) => t.property_id),
        ...woRows.map((w) => w.property_id),
      ])
      return [...ids]
    }

    async function syncPropertyAssets(propertyIds: string[]): Promise<void> {
      if (!propertyIds.length) return
      const db = getDexieDb(userId!)

      const { data: assets, error } = await supabase
        .from('property_assets')
        .select('id, org_id, property_id, asset_type, make, model, is_na, photo_url')
        .in('property_id', propertyIds)
        .eq('is_active', true)
      if (error) {
        console.error('[DexieProvider] property_assets fetch failed:', error)
        return
      }

      if (assets?.length) {
        const normalized = assets.map((a: Record<string, unknown>) => ({
          ...a,
          make:      a.make ?? '',
          model:     a.model ?? '',
          is_na:     a.is_na ? 1 : 0,
          photo_url: a.photo_url ?? '',
        }))
        await db.property_assets.bulkPut(normalized as PropertyAssetRow[])
      }
    }

    // Refreshes the Realtime subscription covering property_assets changes to
    // exactly this crew member's currently-assigned properties — mirrors
    // refreshChecklistSubscription's generation-token guard against
    // out-of-order concurrent calls.
    async function refreshAssetsSubscription(): Promise<void> {
      const myGeneration = ++assetsRefreshGeneration
      const propertyIds = await computeAssignedPropertyIds()
      if (myGeneration !== assetsRefreshGeneration) return // superseded

      const sameSet = propertyIds.length === subscribedAssetPropertyIds.length
        && propertyIds.every((id) => subscribedAssetPropertyIds.includes(id))
      if (sameSet) return

      subscribedAssetPropertyIds = propertyIds
      await syncPropertyAssets(propertyIds)
      if (myGeneration !== assetsRefreshGeneration) return // superseded while syncing

      // Only remove the old channel once we're committed to installing this
      // call's replacement — removing it earlier (before the second await)
      // let an older, still-in-flight call win the race and orphan whichever
      // channel a newer call had already created.
      if (assetsChannel) {
        supabase.removeChannel(assetsChannel)
        assetsChannel = null
      }
      if (!propertyIds.length) return

      assetsChannel = supabase
        .channel(`property-assets-${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'property_assets', filter: `property_id=in.(${propertyIds.join(',')})` },
          () => { void syncPropertyAssets(subscribedAssetPropertyIds) }
        )
        .subscribe()
    }

    let channel: ReturnType<typeof supabase.channel> | null = null
    let checklistChannel: ReturnType<typeof supabase.channel> | null = null
    let assetsChannel: ReturnType<typeof supabase.channel> | null = null
    let subscribedTurnoverIds: string[] = []
    let subscribedAssetPropertyIds: string[] = []
    let checklistRefreshGeneration = 0
    let assetsRefreshGeneration = 0

    async function run() {
      const { data: crewMember } = await supabase
        .from('crew_members')
        .select('id, org_id')
        .eq('user_id', userId!)
        .eq('is_active', true)
        .maybeSingle()
      if (!crewMember || cancelled) return

      setCrewMemberId(crewMember.id as string)

      // force=true: full pull on mount, bypasses any stale watermark
      await Promise.all([
        syncAssignedTurnovers(crewMember.id, true),
        syncWorkOrders(crewMember.id),
        syncMessages(),
        syncCrewAvailability(crewMember.id),
      ])
      if (cancelled) return

      await refreshChecklistSubscription(crewMember.id)
      await refreshAssetsSubscription()

      channel = supabase
        .channel(`turnover-assignments-${crewMember.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'turnover_assignments', filter: `crew_member_id=eq.${crewMember.id}` },
          async () => {
            await syncAssignedTurnovers(crewMember.id, false)
            if (!cancelled) await refreshChecklistSubscription(crewMember.id)
            if (!cancelled) await refreshAssetsSubscription()
          }
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'work_orders', filter: `assigned_crew_member_id=eq.${crewMember.id}` },
          () => {
            void syncWorkOrders(crewMember.id).then(() => {
              if (!cancelled) return refreshAssetsSubscription()
            })
          }
        )
        .subscribe()
    }

    run().catch((err) => console.error('[DexieProvider] sync failed:', err))

    return () => {
      cancelled = true
      if (channel) supabase.removeChannel(channel)
      if (checklistChannel) supabase.removeChannel(checklistChannel)
      if (assetsChannel) supabase.removeChannel(assetsChannel)
    }
  }, [userId])

  const db = userId ? getDexieDb(userId) : null

  return (
    <DexieContext.Provider value={{ db, userId, crewMemberId }}>
      {children}
    </DexieContext.Provider>
  )
}

/** Mirrors usePowerSync() from @powersync/react. */
export function useDexieDb(): FieldStayDexie {
  const { db } = useContext(DexieContext)
  if (!db) {
    throw new Error('useDexieDb must be used within a DexieProvider, with an active session')
  }
  return db
}

/** The authenticated user's id, as resolved by the nearest DexieProvider. */
export function useDexieUserId(): string {
  const { userId } = useContext(DexieContext)
  if (!userId) {
    throw new Error('useDexieUserId must be used within a DexieProvider, with an active session')
  }
  return userId
}

/**
 * The active crew_members.id (not the auth user id) as resolved by the
 * nearest DexieProvider. Resolves asynchronously after userId (an extra
 * crew_members lookup), so unlike useDexieDb/useDexieUserId this returns
 * null rather than throwing during that brief window — callers that need
 * it for a write (e.g. completed_by_crew_id) should guard on it being
 * non-null rather than assume it's always ready synchronously.
 */
export function useCrewMemberId(): string | null {
  const { crewMemberId } = useContext(DexieContext)
  return crewMemberId
}
