// lib/dexie/sync/signals.ts
//
// Pure/injectable pieces of the Crew Sync v2 broadcast-signal client path
// (docs/CREW_SYNC_V2_PHASES.md section 3), extracted from DexieProvider
// (lib/dexie/context.tsx) so they're unit-testable with fake timers and no
// DOM/Supabase dependency:
//
//  - the entity vocabulary + validation (broadcast payloads carry
//    `{ entity }` only — anything not in SYNC_SIGNAL_ENTITIES is ignored),
//  - createSyncSignalHandler(): the signal → action map with a trailing
//    per-entity debounce and per-entity serialization (an in-flight pull
//    plus at most ONE queued follow-up — bursts never stack),
//  - the reconnect-jitter computation (base 5 s + uniform [0, 30 s]).

/** The only entity values a crew-sync broadcast may carry — see the
 * entity → signal mapping table in docs/CREW_SYNC_V2_PHASES.md section 1. */
export const SYNC_SIGNAL_ENTITIES = ['turnovers', 'checklists', 'work_orders'] as const

export type SyncSignalEntity = (typeof SYNC_SIGNAL_ENTITIES)[number]

export function isSyncSignalEntity(value: unknown): value is SyncSignalEntity {
  return typeof value === 'string' && (SYNC_SIGNAL_ENTITIES as readonly string[]).includes(value)
}

/** One async pull per entity. Broadcasts are wake-up signals only, so each
 * action re-pulls its entity's FULL current scope — never a partial pull
 * that could advance a global cursor (cursor invariant #2). */
export type SyncSignalActions = Readonly<Record<SyncSignalEntity, () => Promise<void>>>

export interface SyncSignalHandler {
  /** Feed a raw broadcast payload entity value. Invalid/unknown values are
   * ignored; valid ones (re)start that entity's trailing debounce timer. */
  handleSignal(value: unknown): void
  /** Cancel all pending timers and queued follow-ups. In-flight pulls run
   * to completion but trigger nothing further. */
  dispose(): void
}

export const SIGNAL_DEBOUNCE_MS = 1_000

interface EntityState {
  timer:   ReturnType<typeof setTimeout> | null
  running: boolean
  queued:  boolean
}

/**
 * Builds the broadcast signal → delta-pull dispatcher.
 *
 * Per entity, independently:
 *  - trailing debounce: a burst of N signals inside `debounceMs` collapses
 *    into one action run, `debounceMs` after the last signal;
 *  - serialization: if the debounce fires while a previous run of the same
 *    action is still in flight, exactly one follow-up run is queued (a
 *    second, third, … fire while still in flight queues nothing more) and
 *    starts immediately after the in-flight run settles.
 *
 * Action rejections are logged and never break the handler — the safety
 * poll in DexieProvider is the correctness backstop for a failed pull.
 */
export function createSyncSignalHandler(
  actions: SyncSignalActions,
  debounceMs: number = SIGNAL_DEBOUNCE_MS,
): SyncSignalHandler {
  const states = new Map<SyncSignalEntity, EntityState>()
  let disposed = false

  function stateFor(entity: SyncSignalEntity): EntityState {
    let state = states.get(entity)
    if (!state) {
      state = { timer: null, running: false, queued: false }
      states.set(entity, state)
    }
    return state
  }

  function runAction(entity: SyncSignalEntity): void {
    const state = stateFor(entity)
    if (state.running) {
      state.queued = true // exactly one follow-up, no matter how many fires land meanwhile
      return
    }
    state.running = true
    void actions[entity]()
      .catch((err) => console.error(`[crewSyncSignals] ${entity} pull failed:`, err))
      .finally(() => {
        state.running = false
        if (disposed || !state.queued) return
        state.queued = false
        runAction(entity)
      })
  }

  function handleSignal(value: unknown): void {
    if (disposed || !isSyncSignalEntity(value)) return
    const state = stateFor(value)
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      runAction(value)
    }, debounceMs)
  }

  function dispose(): void {
    disposed = true
    for (const state of states.values()) {
      if (state.timer !== null) clearTimeout(state.timer)
      state.timer = null
      state.queued = false
    }
  }

  return { handleSignal, dispose }
}

// ── Reconnect jitter ───────────────────────────────────────────────────────
// On CHANNEL_ERROR/TIMED_OUT/CLOSED the client rejoins after base + jitter,
// spreading the rejoin herd when a Realtime node restarts and every crew
// device loses its channel at the same instant.

export const RECONNECT_BASE_DELAY_MS = 5_000
export const RECONNECT_JITTER_MAX_MS = 30_000

/** Pure jitter math: `random` ∈ [0, 1) (clamped defensively) maps to a
 * total delay uniform in [RECONNECT_BASE_DELAY_MS,
 * RECONNECT_BASE_DELAY_MS + RECONNECT_JITTER_MAX_MS]. */
export function computeReconnectDelayMs(random: number): number {
  const clamped = Math.min(Math.max(random, 0), 1)
  return RECONNECT_BASE_DELAY_MS + clamped * RECONNECT_JITTER_MAX_MS
}

/** The one impure call site: draws the jitter sample. */
export function reconnectDelayWithJitterMs(): number {
  // eslint-disable-next-line no-restricted-properties -- reconnect jitter to spread realtime rejoins, not id/token generation
  return computeReconnectDelayMs(Math.random())
}
