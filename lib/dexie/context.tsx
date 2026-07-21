'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AuthChangeEvent, Session, RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import {
  getDexieDb,
  cleanupStaleDexieDbs,
  type FieldStayDexie,
  type TurnoverRow,
  type ChecklistInstanceRow,
  type ChecklistInstanceItemRow,
} from './schema'
import { syncAssignedTurnovers, pullChecklistsForTurnovers, pullTurnoversOnly } from './sync/turnovers'
import { syncWorkOrders } from './sync/work-orders'
import { syncMessages } from './sync/messages'
import { syncCrewAvailability } from './sync/availability'
import { computeAssignedPropertyIds, syncPropertyAssets } from './sync/assets'

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
              supabase,
              userId!,
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
              supabase,
              userId!,
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
            void pullTurnoversOnly(supabase, userId!, changedId ? [changedId] : subscribedTurnoverIds)
          }
        )
        .subscribe()
    }

    // Refreshes the Realtime subscription covering property_assets changes to
    // exactly this crew member's currently-assigned properties — mirrors
    // refreshChecklistSubscription's generation-token guard against
    // out-of-order concurrent calls.
    async function refreshAssetsSubscription(): Promise<void> {
      const myGeneration = ++assetsRefreshGeneration
      const propertyIds = await computeAssignedPropertyIds(userId!)
      if (myGeneration !== assetsRefreshGeneration) return // superseded

      const sameSet = propertyIds.length === subscribedAssetPropertyIds.length
        && propertyIds.every((id) => subscribedAssetPropertyIds.includes(id))
      if (sameSet) return

      subscribedAssetPropertyIds = propertyIds
      await syncPropertyAssets(supabase, userId!, propertyIds)
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
          () => { void syncPropertyAssets(supabase, userId!, subscribedAssetPropertyIds) }
        )
        .subscribe()
    }

    let channel: ReturnType<typeof supabase.channel> | null = null
    let checklistChannel: ReturnType<typeof supabase.channel> | null = null
    let assetsChannel: ReturnType<typeof supabase.channel> | null = null
    let onlineHandler: (() => void) | null = null
    let subscribedTurnoverIds: string[] = []
    let subscribedAssetPropertyIds: string[] = []
    let checklistRefreshGeneration = 0
    let assetsRefreshGeneration = 0

    // Realtime's postgres_changes subscriptions never replay events fired
    // while the socket was disconnected — a crew member offline for a
    // stretch (a reassignment, a co-crew-member's checklist completion)
    // would otherwise leave Dexie silently stuck at pre-outage state until
    // the next full page load re-ran run() from scratch. Reusing the exact
    // same full-pull set as the initial mount on every reconnect closes
    // that gap without needing a separate incremental "what did I miss"
    // query.
    async function fullResync(crewMemberId: string): Promise<void> {
      await Promise.all([
        syncAssignedTurnovers(supabase, userId!, crewMemberId, true),
        syncWorkOrders(supabase, userId!, crewMemberId),
        syncMessages(supabase, userId!),
        syncCrewAvailability(supabase, userId!, crewMemberId),
      ])
      if (cancelled) return

      await refreshChecklistSubscription(crewMemberId)
      await refreshAssetsSubscription()
    }

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
      await fullResync(crewMember.id)
      if (cancelled) return

      channel = supabase
        .channel(`turnover-assignments-${crewMember.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'turnover_assignments', filter: `crew_member_id=eq.${crewMember.id}` },
          async () => {
            await syncAssignedTurnovers(supabase, userId!, crewMember.id, false)
            if (!cancelled) await refreshChecklistSubscription(crewMember.id)
            if (!cancelled) await refreshAssetsSubscription()
          }
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'work_orders', filter: `assigned_crew_member_id=eq.${crewMember.id}` },
          () => {
            void syncWorkOrders(supabase, userId!, crewMember.id).then(() => {
              if (!cancelled) return refreshAssetsSubscription()
            })
          }
        )
        .subscribe()

      onlineHandler = () => {
        if (cancelled) return
        void fullResync(crewMember.id).catch((err) =>
          console.error('[DexieProvider] reconnect resync failed:', err)
        )
      }
      globalThis.addEventListener('online', onlineHandler)
    }

    run().catch((err) => console.error('[DexieProvider] sync failed:', err))

    return () => {
      cancelled = true
      if (channel) supabase.removeChannel(channel)
      if (checklistChannel) supabase.removeChannel(checklistChannel)
      if (assetsChannel) supabase.removeChannel(assetsChannel)
      if (onlineHandler) globalThis.removeEventListener('online', onlineHandler)
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
