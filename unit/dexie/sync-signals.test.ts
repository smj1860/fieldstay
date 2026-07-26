// Crew Sync v2 Phase 3 (docs/CREW_SYNC_V2_PHASES.md section 3c):
// the broadcast signal → delta-pull dispatcher — entity validation, the
// per-entity trailing debounce, and in-flight serialization with exactly
// one queued follow-up.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSyncSignalHandler,
  isSyncSignalEntity,
  SYNC_SIGNAL_ENTITIES,
  SIGNAL_DEBOUNCE_MS,
  type SyncSignalActions,
} from '@/lib/dexie/sync/signals'

function makeActions() {
  const turnovers = vi.fn(() => Promise.resolve())
  const checklists = vi.fn(() => Promise.resolve())
  const workOrders = vi.fn(() => Promise.resolve())
  const actions: SyncSignalActions = {
    turnovers,
    checklists,
    work_orders: workOrders,
  }
  return { actions, turnovers, checklists, workOrders }
}

describe('isSyncSignalEntity', () => {
  it('accepts exactly the three known entities', () => {
    for (const entity of SYNC_SIGNAL_ENTITIES) {
      expect(isSyncSignalEntity(entity)).toBe(true)
    }
  })

  it('rejects unknown strings and non-strings', () => {
    expect(isSyncSignalEntity('property_assets')).toBe(false)
    expect(isSyncSignalEntity('TURNOVERS')).toBe(false)
    expect(isSyncSignalEntity('')).toBe(false)
    expect(isSyncSignalEntity(undefined)).toBe(false)
    expect(isSyncSignalEntity(null)).toBe(false)
    expect(isSyncSignalEntity(42)).toBe(false)
    expect(isSyncSignalEntity({ entity: 'turnovers' })).toBe(false)
  })
})

describe('createSyncSignalHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs nothing before the debounce window elapses', async () => {
    const { actions, turnovers } = makeActions()
    const handler = createSyncSignalHandler(actions)

    handler.handleSignal('turnovers')
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS - 1)
    expect(turnovers).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(turnovers).toHaveBeenCalledTimes(1)
    handler.dispose()
  })

  it('coalesces a burst of signals into one pull (trailing debounce)', async () => {
    const { actions, turnovers } = makeActions()
    const handler = createSyncSignalHandler(actions)

    // Five signals inside the window; the timer restarts on each.
    for (let i = 0; i < 5; i++) {
      handler.handleSignal('turnovers')
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(turnovers).not.toHaveBeenCalled()

    // Fires SIGNAL_DEBOUNCE_MS after the LAST signal.
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS - 100)
    expect(turnovers).toHaveBeenCalledTimes(1)

    // Quiet afterwards: nothing further fires.
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS * 5)
    expect(turnovers).toHaveBeenCalledTimes(1)
    handler.dispose()
  })

  it('ignores unknown entities entirely', async () => {
    const { actions, turnovers, checklists, workOrders } = makeActions()
    const handler = createSyncSignalHandler(actions)

    handler.handleSignal('bogus')
    handler.handleSignal(undefined)
    handler.handleSignal(null)
    handler.handleSignal(7)
    handler.handleSignal('property_assets')

    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS * 3)
    expect(turnovers).not.toHaveBeenCalled()
    expect(checklists).not.toHaveBeenCalled()
    expect(workOrders).not.toHaveBeenCalled()
    handler.dispose()
  })

  it('maps each entity to its own action, debounced independently', async () => {
    const { actions, turnovers, checklists, workOrders } = makeActions()
    const handler = createSyncSignalHandler(actions)

    handler.handleSignal('turnovers')
    handler.handleSignal('checklists')
    handler.handleSignal('work_orders')

    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS)
    expect(turnovers).toHaveBeenCalledTimes(1)
    expect(checklists).toHaveBeenCalledTimes(1)
    expect(workOrders).toHaveBeenCalledTimes(1)

    // A signal for one entity never restarts another entity's timer.
    handler.handleSignal('turnovers')
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS / 2)
    handler.handleSignal('checklists')
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS / 2)
    expect(turnovers).toHaveBeenCalledTimes(2)
    expect(checklists).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS / 2)
    expect(checklists).toHaveBeenCalledTimes(2)
    handler.dispose()
  })

  it('serializes per entity: fires during an in-flight pull queue exactly one follow-up', async () => {
    vi.useFakeTimers()
    const resolvers: Array<() => void> = []
    const turnovers = vi.fn(
      () => new Promise<void>((resolve) => { resolvers.push(resolve) })
    )
    const { actions: base } = makeActions()
    const handler = createSyncSignalHandler({ ...base, turnovers })

    // First pull starts and stays in flight.
    handler.handleSignal('turnovers')
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS)
    expect(turnovers).toHaveBeenCalledTimes(1)

    // THREE separate debounce firings land while it's still in flight …
    for (let i = 0; i < 3; i++) {
      handler.handleSignal('turnovers')
      await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS)
    }
    // … none of them start a concurrent pull.
    expect(turnovers).toHaveBeenCalledTimes(1)

    // Completing the in-flight pull releases exactly ONE queued follow-up.
    resolvers[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(turnovers).toHaveBeenCalledTimes(2)

    // Completing the follow-up releases nothing more — no stacking.
    resolvers[1]!()
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS * 5)
    expect(turnovers).toHaveBeenCalledTimes(2)
    handler.dispose()
  })

  it('a rejected pull is contained and does not block later signals', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const turnovers = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(undefined)
    const { actions: base } = makeActions()
    const handler = createSyncSignalHandler({ ...base, turnovers })

    handler.handleSignal('turnovers')
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS)
    expect(turnovers).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalled()

    handler.handleSignal('turnovers')
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS)
    expect(turnovers).toHaveBeenCalledTimes(2)

    handler.dispose()
    consoleError.mockRestore()
  })

  it('dispose cancels pending timers, queued follow-ups, and future signals', async () => {
    const resolvers: Array<() => void> = []
    const turnovers = vi.fn(
      () => new Promise<void>((resolve) => { resolvers.push(resolve) })
    )
    const { actions: base, checklists } = makeActions()
    const handler = createSyncSignalHandler({ ...base, turnovers })

    // An in-flight pull with a queued follow-up …
    handler.handleSignal('turnovers')
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS)
    handler.handleSignal('turnovers')
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS)
    expect(turnovers).toHaveBeenCalledTimes(1)
    // … and a pending (not yet fired) debounce timer.
    handler.handleSignal('checklists')
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS / 2)

    handler.dispose()

    // Pending checklist timer never fires.
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS * 5)
    expect(checklists).not.toHaveBeenCalled()

    // Queued turnovers follow-up is dropped when the in-flight pull settles.
    resolvers[0]!()
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS * 5)
    expect(turnovers).toHaveBeenCalledTimes(1)

    // Post-dispose signals are no-ops.
    handler.handleSignal('turnovers')
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS * 5)
    expect(turnovers).toHaveBeenCalledTimes(1)
  })
})
