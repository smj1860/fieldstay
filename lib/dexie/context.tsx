'use client'

import { tryUnwrap } from '@/lib/supabase/unwrap'
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
import { computeAssignedPropertyIds, syncPropertyAssets } from './sync/assets'
import { fullCrewResync } from './sync/full-resync'
import {
  createSyncSignalHandler,
  reconnectDelayWithJitterMs,
  type SyncSignalHandler,
} from './sync/signals'

// Crew Sync v2 (docs/CREW_SYNC_V2_PHASES.md Phase 3): broadcast signal +
// delta pull instead of postgres_changes. Ships dormant — the flag defaults
// off and the v1 path below stays the production behavior until Phase 5.
// NEXT_PUBLIC_ vars are inlined at build time, so this is a build-time
// constant, not a runtime toggle.
const CREW_SYNC_V2 = process.env.NEXT_PUBLIC_CREW_SYNC_V2 === 'true'

/** How often the safety poll runs a full resync — the correctness backstop
 * for missed Realtime events/broadcasts and the only freshness path for
 * property_assets, which deliberately has no broadcast trigger.
 *
 * Runs on BOTH sync paths. It used to be v2-only, which meant the shipping
 * (flag-off) configuration had no safety poll at all: messages,
 * inventory_items and properties refreshed only on mount
 * and on `online`, and the crew-sync-coverage guardrail asserted a mechanism
 * that wasn't running. */
const SAFETY_POLL_INTERVAL_MS = 5 * 60_000

interface DexieContextValue {
  db:           FieldStayDexie | null
  userId:       string | null
  crewMemberId: string | null
}

const DexieContext = createContext<DexieContextValue>({ db: null, userId: null, crewMemberId: null })

/**
 * Resolves the active user's session — returning null rather than throwing
 * when there is no session yet, since the provider mounts before auth has
 * necessarily settled — then hands the per-user Dexie instance down through
 * context.
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
    // Shared by both sync paths — see installSafetyPoll below.
    let safetyPollTimer: ReturnType<typeof setInterval> | null = null
    let subscribedTurnoverIds: string[] = []
    let subscribedAssetPropertyIds: string[] = []
    let checklistRefreshGeneration = 0
    let assetsRefreshGeneration = 0

    // ── Crew Sync v2 state (all stays null/untouched when the flag is off) ─
    let v2Channel: ReturnType<typeof supabase.channel> | null = null
    let v2ReconnectTimer: ReturnType<typeof setTimeout> | null = null

    let visibilityHandler: (() => void) | null = null
    let bootRetryHandler: (() => void) | null = null
    let v2AuthSubscription: { unsubscribe: () => void } | null = null
    let v2SignalHandler: SyncSignalHandler | null = null

    // Realtime's postgres_changes subscriptions never replay events fired
    // while the socket was disconnected — a crew member offline for a
    // stretch (a reassignment, a co-crew-member's checklist completion)
    // would otherwise leave Dexie silently stuck at pre-outage state until
    // the next full page load re-ran run() from scratch. Running the same
    // sync set as the initial mount on every reconnect closes that gap.
    //
    // Since sync-v2 (crew sync Phase 1) this is delta, not a full re-pull:
    // each sync function reconciles scope membership with a cheap full
    // id-set fetch (which handles unassignment/completion deletions) and
    // transfers row data via per-entity updated_at cursors — so a
    // reconnect after a quiet stretch costs a handful of near-empty
    // queries instead of re-downloading every assigned turnover's full
    // checklist. Cursors are a bandwidth optimization only; correctness
    // never depends on them (see lib/dexie/sync/cursors.ts).
    async function resync(crewMemberId: string): Promise<void> {
      await fullCrewResync(supabase, userId!, crewMemberId)
      if (cancelled) return

      await refreshChecklistSubscription(crewMemberId)
      await refreshAssetsSubscription()
    }

    // ── Resync coalescing ─────────────────────────────────────────────────
    //
    // A phone waking in a parking lot fires `online` and `visibilitychange →
    // visible` within the same second, and the 5-minute safety poll can land
    // in the same window; on the v1 path a turnover_assignments event can too.
    // Each of those used to start its own fullCrewResync with nothing
    // serializing them, so three concurrent passes ran on the worst possible
    // connection — tripling the query volume, racing advanceCursor()'s
    // read-modify-write, and letting one pass's pruneLocalCache() bulkDelete
    // from a snapshot another was still mutating (visible as flicker and
    // transient empty states).
    //
    // One in flight, at most one queued follow-up — the same shape
    // createSyncSignalHandler() already uses per entity.
    let resyncInFlight: Promise<void> | null = null
    let resyncQueued = false

    function runCoalesced(run: () => Promise<void>, label: string): void {
      if (cancelled) return
      if (resyncInFlight) {
        resyncQueued = true
        return
      }
      resyncInFlight = run()
        .catch((err) => console.error(`[DexieProvider] ${label} failed:`, err))
        .finally(() => {
          resyncInFlight = null
          if (cancelled || !resyncQueued) return
          resyncQueued = false
          runCoalesced(run, label)
        })
    }

    function resyncSafe(crewMemberId: string): void {
      runCoalesced(() => resync(crewMemberId), 'resync')
    }

    // Installed on BOTH paths (see SAFETY_POLL_INTERVAL_MS above) — the
    // correctness backstop is not allowed to depend on a feature flag.
    function installSafetyPoll(run: () => void): void {
      safetyPollTimer = setInterval(run, SAFETY_POLL_INTERVAL_MS)
    }

    // ── Crew Sync v2 (flag on): broadcast signal + delta pull ──────────────
    // No postgres_changes channels at all. One private broadcast channel
    // (`crew:{userId}`) delivers tiny `{ entity }` wake-up signals; the
    // client answers each with a debounced full-scope delta pull. A 5-minute
    // safety poll plus resyncs on mount/online/visible/(re)subscribe are the
    // correctness backstops — a missed broadcast only ever costs latency.

    // Full v2 resync: all entities + reconciliation. Unlike v1's resync()
    // this never touches channel subscriptions — the single broadcast
    // channel's scope is the user id, which never changes mid-session — and
    // it also covers property_assets (no broadcast trigger; see the doc's
    // section 1) directly instead of via refreshAssetsSubscription.
    async function resyncV2(crewMemberId: string): Promise<void> {
      await fullCrewResync(supabase, userId!, crewMemberId)
    }

    function resyncV2Safe(crewMemberId: string): void {
      runCoalesced(() => resyncV2(crewMemberId), 'v2 resync')
    }

    // Retry helper for scheduleV2Reconnect's timer callback — kept as its
    // own named function (a sibling, not nested inside the timer callback)
    // to keep that callback's nesting depth within the project's ≤4 limit.
    function retrySubscribeV2(crewMemberId: string): void {
      void subscribeV2(crewMemberId).catch((err) => {
        console.error('[DexieProvider] v2 resubscribe failed:', err)
        scheduleV2Reconnect(crewMemberId)
      })
    }

    // Rejoin after base + uniform jitter (5–35 s) so a Realtime node restart
    // doesn't stampede every crew device back at the same instant. Tearing
    // down the old channel sets v2Channel to null FIRST, so the stale
    // channel's own CLOSED status callback (fired by removeChannel) can't
    // schedule a second, competing reconnect loop.
    function scheduleV2Reconnect(crewMemberId: string): void {
      if (cancelled || v2ReconnectTimer !== null) return
      v2ReconnectTimer = setTimeout(() => {
        v2ReconnectTimer = null
        if (cancelled) return
        if (v2Channel) {
          const stale = v2Channel
          v2Channel = null
          supabase.removeChannel(stale)
        }
        retrySubscribeV2(crewMemberId)
      }, reconnectDelayWithJitterMs())
    }

    async function subscribeV2(crewMemberId: string): Promise<void> {
      if (cancelled) return
      // Private channels authorize against RLS on realtime.messages — the
      // realtime socket needs the user's JWT attached before joining.
      // Newer supabase-js versions refresh realtime auth automatically, but
      // the explicit call is harmless and version-proof.
      await supabase.realtime.setAuth()
      if (cancelled) return

      const ch = supabase
        .channel(`crew:${userId}`, { config: { private: true } })
        .on('broadcast', { event: 'sync' }, (message: { payload?: { entity?: unknown } }) => {
          v2SignalHandler?.handleSignal(message.payload?.entity)
        })
        .subscribe((status: string) => {
          // Ignore callbacks from a channel that's been superseded (or a
          // deliberate unmount teardown) — only the current channel may
          // trigger resyncs/reconnects.
          if (cancelled || ch !== v2Channel) return
          if (status === 'SUBSCRIBED') {
            // The gap while disconnected may have swallowed signals.
            resyncV2Safe(crewMemberId)
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            scheduleV2Reconnect(crewMemberId)
          }
        })
      v2Channel = ch
    }

    // Full CURRENT assigned-turnover set from the local cache (kept
    // reconciled by syncAssignedTurnovers) — full scope, so advanceCursors
    // is allowed. All ids are already cached locally, so none qualify as
    // fresh. Kept as its own named function (a sibling, not nested inside
    // runV2's signal-handler map) to keep nesting depth within the
    // project's ≤4 limit.
    async function syncChecklistsV2(crewMemberId: string): Promise<void> {
      const db = getDexieDb(userId!)
      const turnoverIds = (await db.turnovers.toArray()).map((t) => t.id)
      await pullChecklistsForTurnovers(supabase, userId!, turnoverIds, crewMemberId, {
        advanceCursors: true,
      })
    }

    // Kept as its own named function (a sibling, not nested inside runV2)
    // to keep nesting depth within the project's ≤4 limit.
    function handleV2AuthStateChange(event: AuthChangeEvent): void {
      if (event !== 'TOKEN_REFRESHED' || cancelled) return
      void Promise.resolve(supabase.realtime.setAuth()).catch((err: unknown) =>
        console.error('[DexieProvider] v2 realtime setAuth refresh failed:', err)
      )
    }

    async function runV2(crewMemberId: string): Promise<void> {
      // Signal → action map. Every action is a FULL-scope pull for its
      // entity, so cursor advancement is safe (cursor invariant: cursors
      // advance only from full-scope pulls).
      v2SignalHandler = createSyncSignalHandler({
        turnovers: () => syncAssignedTurnovers(supabase, userId!, crewMemberId),
        checklists: () => syncChecklistsV2(crewMemberId),
        work_orders: () => syncWorkOrders(supabase, userId!, crewMemberId),
      })

      // Delta on mount, same as v1: cursors make this cheap, scope
      // reconciliation makes it correct.
      await resyncV2(crewMemberId)
      if (cancelled) return

      // Re-attach the realtime JWT whenever Supabase refreshes the session
      // token, so the private channel doesn't die with the old token. (The
      // provider's other onAuthStateChange listener is skipped entirely
      // when userIdProp is supplied — the crew layout's case — so the v2
      // path registers its own.)
      const { data: authListener } = supabase.auth.onAuthStateChange(handleV2AuthStateChange)
      v2AuthSubscription = authListener.subscription

      onlineHandler = () => resyncV2Safe(crewMemberId)
      globalThis.addEventListener('online', onlineHandler)

      // PWA returning from background has likely missed broadcasts.
      visibilityHandler = () => {
        if (globalThis.document?.visibilityState === 'visible') resyncV2Safe(crewMemberId)
      }
      globalThis.document?.addEventListener('visibilitychange', visibilityHandler)

      // Safety poll: correctness backstop for missed broadcasts and the
      // freshness path for property_assets.
      installSafetyPoll(() => resyncV2Safe(crewMemberId))

      await subscribeV2(crewMemberId)
    }

    // The crew member id, cached across sessions in the local-only sync_meta
    // store. Written on every successful resolution; read back when the live
    // lookup fails.
    //
    // Without this, run() below bailed on ANY failure of that one query — and
    // because every listener (Realtime channels, `online`, `visibilitychange`,
    // the safety poll) is installed after it, and the effect keys on [userId]
    // so it never re-runs, the provider never synced again for the life of the
    // session. That is not a rare path: public/sw.js serves the cached shell
    // on navigation, so a crew member opening the PWA at a property with no
    // signal mounts fully offline and trips exactly this query. crewMemberId
    // then stayed null, which silently disabled both "Confirm Complete"
    // buttons — the turnover could never be completed and no cleaning fee
    // posted, with no error shown anywhere.
    const CREW_ID_KEY = 'crew_member_id'

    async function cacheCrewMemberId(id: string): Promise<void> {
      try {
        await getDexieDb(userId!).sync_meta.put({ key: CREW_ID_KEY, value: id })
      } catch {
        // A cache write failure must never break the boot path it exists to
        // protect — this run already has its id from the live query.
      }
    }

    async function cachedCrewMemberId(): Promise<string | null> {
      try {
        return (await getDexieDb(userId!).sync_meta.get(CREW_ID_KEY))?.value ?? null
      } catch {
        return null
      }
    }

    // run() is now reachable more than once (the boot retry below re-invokes
    // it on `online`), and a flapping connection can fire that repeatedly.
    // Without this latch two concurrent boots would each open their own
    // Realtime channels and install their own safety poll, leaking both.
    let booting = false

    async function run() {
      if (booting || cancelled) return
      booting = true
      try {
        await bootSync()
      } finally {
        booting = false
      }
    }

    async function bootSync() {
      // Degrade, don't throw: this runs inside a client-side effect that has
      // no error boundary of its own, and the provider must not tear down the
      // crew PWA over one failed lookup. tryUnwrap still logs and reports, so
      // the failure is no longer silent.
      const crewRes = await supabase
        .from('crew_members')
        .select('id, org_id')
        .eq('user_id', userId!)
        .eq('is_active', true)
        .maybeSingle()

      const crewOut    = tryUnwrap<{ id: string; org_id: string }>(crewRes, { site: 'dexie.context.crew-member' })
      const crewMember = crewOut.ok ? crewOut.data : null

      if (cancelled) return

      // Live lookup won: cache it so a later offline mount can still boot.
      if (crewMember) {
        void cacheCrewMemberId(crewMember.id as string)
      }

      // Live lookup failed (offline mount, transient 5xx, cold start). Fall
      // back to the id this device resolved on a previous session so the rest
      // of the provider — listeners, safety poll, and the two confirm buttons
      // — still comes up. Reads are served from the Dexie cache anyway; the
      // outbox is what carries writes back when signal returns.
      const resolvedCrewId = crewMember?.id ?? await cachedCrewMemberId()
      if (cancelled) return

      if (!resolvedCrewId) {
        // Never resolved on this device, so there is nothing to fall back to.
        // Retry when connectivity returns instead of leaving the provider
        // permanently inert — this listener is deliberately installed even
        // though the rest of the boot did not happen.
        if (!bootRetryHandler) {
          bootRetryHandler = () => { void run() }
          globalThis.addEventListener('online', bootRetryHandler)
        }
        return
      }

      // Boot is going ahead, so the retry listener has done its job. Leaving
      // it installed would re-enter run() on the next `online` and install a
      // second set of channels and a second safety poll.
      if (bootRetryHandler) {
        globalThis.removeEventListener('online', bootRetryHandler)
        bootRetryHandler = null
      }

      setCrewMemberId(resolvedCrewId)

      if (CREW_SYNC_V2) {
        await runV2(resolvedCrewId)
        return
      }

      // Delta on mount too: a device with cursors only fetches what changed
      // since it last synced; a fresh device (no cursors) naturally does a
      // full pull. Scope reconciliation inside syncAssignedTurnovers guards
      // against a stale cursor ever hiding an assignment change.
      await resync(resolvedCrewId)
      if (cancelled) return

      channel = supabase
        .channel(`turnover-assignments-${resolvedCrewId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'turnover_assignments', filter: `crew_member_id=eq.${resolvedCrewId}` },
          async () => {
            await syncAssignedTurnovers(supabase, userId!, resolvedCrewId)
            if (!cancelled) await refreshChecklistSubscription(resolvedCrewId)
            if (!cancelled) await refreshAssetsSubscription()
          }
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'work_orders', filter: `assigned_crew_member_id=eq.${resolvedCrewId}` },
          () => {
            void syncWorkOrders(supabase, userId!, resolvedCrewId).then(() => {
              if (!cancelled) return refreshAssetsSubscription()
            })
          }
        )
        .subscribe()

      onlineHandler = () => resyncSafe(resolvedCrewId)
      globalThis.addEventListener('online', onlineHandler)

      // PWA returning from background has likely missed postgres_changes
      // events — Realtime never replays what happened while disconnected.
      visibilityHandler = () => {
        if (globalThis.document?.visibilityState === 'visible') resyncSafe(resolvedCrewId)
      }
      globalThis.document?.addEventListener('visibilitychange', visibilityHandler)

      // Safety poll: same correctness backstop v2 has, on the path that
      // actually ships today.
      installSafetyPoll(() => resyncSafe(resolvedCrewId))
    }

    run().catch((err) => console.error('[DexieProvider] sync failed:', err))

    return () => {
      cancelled = true
      if (channel) supabase.removeChannel(channel)
      if (checklistChannel) supabase.removeChannel(checklistChannel)
      if (assetsChannel) supabase.removeChannel(assetsChannel)
      if (onlineHandler) globalThis.removeEventListener('online', onlineHandler)
      if (bootRetryHandler) globalThis.removeEventListener('online', bootRetryHandler)
      // Crew Sync v2 teardown — everything here is null when the flag is off.
      if (v2Channel) {
        const ch = v2Channel
        v2Channel = null // deliberate unmount: the CLOSED callback must not reconnect
        supabase.removeChannel(ch)
      }
      if (v2ReconnectTimer !== null) clearTimeout(v2ReconnectTimer)
      if (safetyPollTimer !== null) clearInterval(safetyPollTimer)
      if (visibilityHandler) globalThis.document?.removeEventListener('visibilitychange', visibilityHandler)
      v2AuthSubscription?.unsubscribe()
      v2SignalHandler?.dispose()
    }
  }, [userId])

  const db = userId ? getDexieDb(userId) : null

  return (
    <DexieContext.Provider value={{ db, userId, crewMemberId }}>
      {children}
    </DexieContext.Provider>
  )
}

/** Returns the current user's Dexie instance from context. */
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
