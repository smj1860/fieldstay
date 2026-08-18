import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// The hourly Hostaway incremental sweep, which stands in for webhooks.
//
// Hostaway can deliver webhooks, but its public API reference documents no
// unified-webhook endpoint and no payload schema (checked 2026-08-18), and the
// field that matters most is whichever identifies the ACCOUNT — guess that
// wrong and a delivery is attributed to an arbitrary org. So the gap is closed
// by polling latestActivityStart instead, which is a genuine changed-since
// filter and needs nothing undocumented.
//
// What is asserted here is what only this design can get wrong: the jitter's
// determinism (a random one turns "hourly" into a 113-minute gap followed by a
// 7-minute one), and the cursor's ordering (advanced only after the pipeline
// succeeded, and stepped back a day so a change landing mid-run is not lost
// between two sweeps).
// ============================================================================

import {
  jitterSecondsForConnection,
  JITTER_WINDOW_SECONDS,
} from '@/lib/inngest/functions/hostaway/incremental-sync-cron'

describe('jitterSecondsForConnection', () => {
  it('is deterministic — the same connection lands at the same offset every hour', () => {
    // THE POINT. With Math.random a connection could sync at :05 and then at
    // :58 — a 113-minute gap on an "hourly" sync — then twice 7 minutes apart.
    // A stable hash keeps each connection's own interval at ~60 minutes.
    const a = jitterSecondsForConnection('user-abc')
    const b = jitterSecondsForConnection('user-abc')
    expect(a).toBe(b)
  })

  it('stays inside the dispatch window', () => {
    for (const id of ['a', 'user-1', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', '']) {
      const s = jitterSecondsForConnection(id)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(JITTER_WINDOW_SECONDS)
    }
  })

  it('leaves headroom before the next hourly tick', () => {
    // A window of a full 3600s would let one connection's run start exactly as
    // the next cron fires, which is the collision the per-org concurrency cap
    // then has to absorb every hour.
    expect(JITTER_WINDOW_SECONDS).toBeLessThan(3600)
  })

  it('actually spreads a realistic fleet rather than clustering', () => {
    // A hash that collapses (returning a constant, or keying only on length)
    // would satisfy determinism and bounds while spreading nothing — and the
    // thundering herd this exists to prevent would be entirely intact.
    const ids = Array.from({ length: 200 }, (_, i) => `f47ac10b-58cc-4372-a567-${String(i).padStart(12, '0')}`)
    const offsets = ids.map(jitterSecondsForConnection)

    // Distinct offsets: allow some collision (a modulo over 200 samples will
    // collide occasionally) but require genuine spread.
    expect(new Set(offsets).size).toBeGreaterThan(150)

    // And spread across the window, not bunched into one corner of it.
    const buckets = new Set(offsets.map((s) => Math.floor(s / (JITTER_WINDOW_SECONDS / 10))))
    expect(buckets.size).toBeGreaterThanOrEqual(8)
  })

  it('gives different connections different offsets', () => {
    expect(jitterSecondsForConnection('user-a')).not.toBe(jitterSecondsForConnection('user-b'))
  })
})

// ── Handler ─────────────────────────────────────────────────────────────────

vi.mock('@/lib/integrations/vault', () => ({ readIntegrationToken: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/inngest/functions/hostaway/reservation-sync', () => ({
  syncHostawayReservations: vi.fn(),
}))
vi.mock('@/lib/integrations/connection-metadata', () => ({
  mergeIntegrationConnectionMetadata: vi.fn(),
  SYNCABLE_CONNECTION_STATUSES: ['active', 'error'],
}))

import { hostawayIncrementalSyncHandler } from '@/lib/inngest/functions/hostaway/incremental-sync-handler'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { createServiceClient } from '@/lib/supabase/server'
import { syncHostawayReservations } from '@/lib/inngest/functions/hostaway/reservation-sync'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
import { invokeHandler } from './test-helpers'

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

function makeStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sleep:     vi.fn(),
    sendEvent: vi.fn(),
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** `metadata` drives the cursor; `properties` drives the id map. */
function makeSupabase(metadata: Record<string, unknown>, properties: unknown[]) {
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'not', 'limit']) chain[m] = () => chain
    chain.maybeSingle = () => Promise.resolve({ data: { metadata }, error: null })
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        table === 'properties' ? { data: properties, error: null } : { data: null, error: null },
      ).then(resolve)
    return chain
  })
  return { from }
}

const PROPERTIES = [{ id: 'prop_uuid', external_id: '101' }]

function run(step = makeStep()) {
  return invokeHandler(hostawayIncrementalSyncHandler, {
    event:  { data: { user_id: 'user_1', org_id: 'org_1', external_user_id: 'acct_1' } },
    step,
    logger: makeLogger(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mock(readIntegrationToken).mockResolvedValue('token_abc')
  mock(createServiceClient).mockReturnValue(
    makeSupabase({ incremental_cursor: '2026-08-01' }, PROPERTIES),
  )
  mock(syncHostawayReservations).mockResolvedValue({ reservationCount: 4, newTurnoverIds: ['t1'] })
  mock(mergeIntegrationConnectionMetadata).mockResolvedValue({})
})

describe('hostawayIncrementalSyncHandler', () => {
  it('sweeps by CHANGE since the stored cursor, not by arrival date', () => {
    // An arrival-date window anchored near today cannot see a cancellation of a
    // stay six months out — which is the change most worth hearing about
    // within the hour. That is the whole reason this mode exists.
    return run().then(() => {
      const params = mock(syncHostawayReservations).mock.calls[0][0]
      expect(params.fetchMode).toEqual({ kind: 'activitySince', since: '2026-08-01' })
    })
  })

  it("posts revenue 'new-only' — 'all' would fire per booking per org every hour", async () => {
    await run()
    expect(mock(syncHostawayReservations).mock.calls[0][0].revenueMode).toBe('new-only')
  })

  it('advances the cursor only AFTER the pipeline succeeds', async () => {
    // Ordering is the assertion. Advancing first — or in the same step as the
    // fetch — skips a window whose upserts then failed, and nothing re-reads it
    // until the next day's reconcile.
    mock(syncHostawayReservations).mockRejectedValue(new Error('pipeline blew up'))

    await expect(run()).rejects.toThrow(/pipeline blew up/)
    expect(mergeIntegrationConnectionMetadata).not.toHaveBeenCalled()
  })

  it('leaves a day of deliberate overlap when it does advance', async () => {
    // Not "today". A change landing between the fetch and the cursor write
    // would otherwise fall into the gap between two runs and go unseen until
    // the daily reconcile. One re-read is the cheaper failure.
    await run()

    const patch = mock(mergeIntegrationConnectionMetadata).mock.calls[0][0].patch
    const cursor = patch.incremental_cursor as string
    expect(cursor).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const today = new Date().toISOString().slice(0, 10)
    expect(cursor < today).toBe(true)
  })

  it('cold-starts on a recent window when no cursor is stored', async () => {
    // A wide cold-start window would turn every first hourly run into a second
    // full backfill, moments after the 12-month initial sync already ran.
    mock(createServiceClient).mockReturnValue(makeSupabase({}, PROPERTIES))

    await run()

    const since = mock(syncHostawayReservations).mock.calls[0][0].fetchMode.since as string
    const daysAgo = (Date.now() - new Date(since).getTime()) / 86_400_000
    expect(daysAgo).toBeLessThanOrEqual(3)
  })

  it('skips entirely — no fetch — when the org has no synced properties yet', async () => {
    mock(createServiceClient).mockReturnValue(makeSupabase({ incremental_cursor: '2026-08-01' }, []))

    const result = await run()

    expect(result).toEqual({ skipped: true, reason: 'no_properties' })
    expect(syncHostawayReservations).not.toHaveBeenCalled()
  })

  it('fails NON-retriably when the token is gone', async () => {
    // Hostaway's API key cannot be refreshed at all, so retrying hourly against
    // a dead credential only buries the real failures.
    const { NonRetriableError } = await import('inngest')
    mock(readIntegrationToken).mockResolvedValue(null)

    await expect(run()).rejects.toBeInstanceOf(NonRetriableError)
  })
})
