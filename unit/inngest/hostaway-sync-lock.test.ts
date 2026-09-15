import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// The cross-FUNCTION lock between the hourly incremental sweep and the daily
// reconcile. Each handler's own `concurrency: [{ limit: 1, key:
// 'event.data.org_id' }]` only serializes it against ITSELF — the two are
// distinct Inngest function ids, so that key does nothing to stop them
// running at once for the same org. The reconcile cron fires un-jittered at
// 07:30 UTC while the incremental cron jitters individual dispatches up to 55
// minutes into the next hour, so the two genuinely overlap every day, both
// racing generateTurnoversForProperty with no guard.
// ============================================================================

vi.mock('@/lib/cache/single-flight', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}))
vi.mock('@/lib/integrations/vault', () => ({ readIntegrationToken: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/supabase/unwrap', () => ({ unwrap: vi.fn() }))
vi.mock('@/lib/integrations/connection-metadata', () => ({ mergeIntegrationConnectionMetadata: vi.fn() }))
vi.mock('@/lib/inngest/functions/hostaway/reservation-sync', () => ({ syncHostawayReservations: vi.fn() }))
vi.mock('@/lib/inngest/functions/hostaway/reviews-sync', () => ({ syncHostawayReviews: vi.fn() }))
vi.mock('@/lib/inngest/functions/shared/revoke-and-notify', () => ({ revokeAndNotify: vi.fn() }))
vi.mock('@/lib/inngest/functions/shared/reconcile-shell', () => ({ runProviderReconcile: vi.fn() }))

import { hostawayIncrementalSyncHandler } from '@/lib/inngest/functions/hostaway/incremental-sync-handler'
import { hostawayReservationReconcileHandler } from '@/lib/inngest/functions/hostaway/reservation-reconcile-handler'
import { hostawaySyncLockKey } from '@/lib/inngest/functions/hostaway/sync-lock'
import { acquireLock, releaseLock } from '@/lib/cache/single-flight'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrap } from '@/lib/supabase/unwrap'
import { runProviderReconcile } from '@/lib/inngest/functions/shared/reconcile-shell'
import { invokeHandler } from './test-helpers'

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

function makeStep() {
  return { run: vi.fn((_n: string, cb: () => unknown) => cb()), sleep: vi.fn(), sendEvent: vi.fn() }
}
function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

const EVENT_DATA = { user_id: 'user_1', org_id: 'org_1' }

beforeEach(() => {
  vi.clearAllMocks()
  mock(readIntegrationToken).mockResolvedValue('token_abc')
  // Both unwrap() calls in the handler (connection read, then properties
  // read) are satisfied by the same harmless empty value: `conn?.metadata`
  // on `[]` is undefined, which the handler already falls back from, and the
  // properties for-of loop over `[]` is a no-op — reaching the intended
  // "no_properties" early return without needing call-order-specific mocks.
  mock(unwrap).mockReturnValue([])
  mock(runProviderReconcile).mockResolvedValue({ reservations: 0 })
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'not', 'limit']) chain[m] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: { metadata: {} }, error: null }))
  chain.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r)
  mock(createServiceClient).mockReturnValue({ from: vi.fn(() => chain) })
})

describe('hostawaySyncLockKey', () => {
  it('produces the SAME key for both handlers, for the same org', () => {
    // This lock is only meaningful if both files derive an identical string —
    // a typo'd suffix in either one would silently defeat the whole guard.
    expect(hostawaySyncLockKey('org_1')).toBe(hostawaySyncLockKey('org_1'))
    expect(hostawaySyncLockKey('org_1')).not.toBe(hostawaySyncLockKey('org_2'))
  })
})

describe('hostawayIncrementalSyncHandler — cross-function lock', () => {
  it('skips the sweep entirely when the reconcile holds the lock', async () => {
    mock(acquireLock).mockResolvedValue(false)

    const result = await invokeHandler(hostawayIncrementalSyncHandler, {
      event: { data: EVENT_DATA }, step: makeStep(), logger: makeLogger(),
    })

    expect(result).toEqual({ skipped: true, reason: 'reconcile_in_progress' })
    // Never reached the token/properties read, let alone the pipeline.
    expect(readIntegrationToken).not.toHaveBeenCalled()
    expect(releaseLock).not.toHaveBeenCalled() // never held it — nothing to release
  })

  it('acquires and releases the lock around a successful run', async () => {
    mock(acquireLock).mockResolvedValue(true)

    await invokeHandler(hostawayIncrementalSyncHandler, {
      event: { data: EVENT_DATA }, step: makeStep(), logger: makeLogger(),
    })

    expect(acquireLock).toHaveBeenCalledWith(hostawaySyncLockKey('org_1'), 300)
    expect(releaseLock).toHaveBeenCalledWith(hostawaySyncLockKey('org_1'))
  })

  it('releases the lock even when the run throws', async () => {
    mock(acquireLock).mockResolvedValue(true)
    mock(readIntegrationToken).mockRejectedValue(new Error('vault down'))

    await expect(invokeHandler(hostawayIncrementalSyncHandler, {
      event: { data: EVENT_DATA }, step: makeStep(), logger: makeLogger(),
    })).rejects.toThrow('vault down')

    expect(releaseLock).toHaveBeenCalledWith(hostawaySyncLockKey('org_1'))
  })
})

describe('hostawayReservationReconcileHandler — cross-function lock', () => {
  it('skips the reconcile entirely when the incremental sweep holds the lock', async () => {
    mock(acquireLock).mockResolvedValue(false)

    const result = await invokeHandler(hostawayReservationReconcileHandler, {
      event: { data: EVENT_DATA }, step: makeStep(), logger: makeLogger(),
    })

    expect(result).toEqual({ skipped: true, reason: 'incremental_sync_in_progress' })
    expect(runProviderReconcile).not.toHaveBeenCalled()
  })

  it('acquires and releases the lock around a successful run', async () => {
    mock(acquireLock).mockResolvedValue(true)

    await invokeHandler(hostawayReservationReconcileHandler, {
      event: { data: EVENT_DATA }, step: makeStep(), logger: makeLogger(),
    })

    expect(acquireLock).toHaveBeenCalledWith(hostawaySyncLockKey('org_1'), 300)
    expect(releaseLock).toHaveBeenCalledWith(hostawaySyncLockKey('org_1'))
  })
})
