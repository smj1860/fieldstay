import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable-token', () => ({
  // The refresh-AWARE getter, which is what both of these paths must use.
  // A raw readIntegrationToken returns whatever is in Vault without checking
  // expiry, and Hospitable access tokens live 12 hours — that produced a live
  // 401 on 2026-08-18 when the reconcile cron (10:00 UTC) read a token that
  // expired at 10:00:06.
  getValidHospitableToken: vi.fn(async () => 'tok_live'),
}))
vi.mock('@/lib/integrations/vault', () => ({
  readIntegrationToken: vi.fn(async () => 'tok_live'),
}))
vi.mock('@/lib/turnovers/generator', () => ({
  generateTurnoversForProperty: vi.fn(async () => []),
}))
vi.mock('@/lib/inngest/turnover-created-events', () => ({
  fetchTurnoverCreatedEvents: vi.fn(async () => []),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))
// The provider adapter is the only network boundary in this whole path.
vi.mock('@/lib/integrations/providers/hospitable', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/integrations/providers/hospitable',
  )
  return {
    ...actual,
    fetchReservationsWindow: vi.fn(async () => []),
  }
})

import { hospReservationReconcileCron }    from '@/lib/inngest/functions/hospitable/reservation-reconcile-cron'
import { hospReservationReconcileHandler } from '@/lib/inngest/functions/hospitable/reservation-reconcile-handler'
import { createServiceClient }   from '@/lib/supabase/server'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { fetchReservationsWindow } from '@/lib/integrations/providers/hospitable'
import { invokeHandler } from './test-helpers'

// ============================================================================
// The missed-webhook backstop for Hospitable reservations.
//
// Hospitable reservations were webhook-ONLY: hospIncrementalSync fires solely
// from the webhook path, and reservation history was pulled exactly once by
// hospInitialSync on connect. The two pre-existing Hospitable crons cover
// calendar BLOCKS and teammates, neither of which is a reservation. So a
// reservation created while webhook delivery was broken never arrived and
// nothing ever noticed — which is precisely what a rotated webhook secret
// caused on 2026-08-15.
//
// These tests pin the two properties that make the backstop real: it must
// reach EVERY connection (not the first page of them), and it must not
// re-post revenue it has already posted.
// ============================================================================

function runAllStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sendEvent: vi.fn(),
  }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

/** Records every write so a test can assert on what was upserted. */
interface Recorded { table: string; rows: unknown }

function makeSupabase(queued: QueuedByTable, upserts: Recorded[] = []) {
  const counters: Record<string, number> = {}

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = () => chain
    chain.order  = vi.fn(() => chain)
    chain.range  = vi.fn(() => chain)
    chain.eq     = () => chain
    chain.in     = () => chain
    chain.not    = () => chain
    chain.upsert = vi.fn((rows: unknown) => {
      upserts.push({ table, rows })
      return Promise.resolve({ error: null })
    })

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: [], error: null })
    }

    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(getValidHospitableToken as ReturnType<typeof vi.fn>).mockResolvedValue('tok_live')
  ;(fetchReservationsWindow as ReturnType<typeof vi.fn>).mockResolvedValue([])
})

// ── The cron ────────────────────────────────────────────────────────────────

describe('hospReservationReconcileCron', () => {
  it('dispatches one reconcile event per active connection', async () => {
    const supabase = makeSupabase({
      integration_connections: [{
        data: [
          { user_id: 'u1', org_id: 'org_1', external_user_id: 'x1' },
          { user_id: 'u2', org_id: 'org_2', external_user_id: 'x2' },
        ],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const res = await invokeHandler(hospReservationReconcileCron, {
      event: {}, step, logger: makeLogger(),
    }) as { dispatched: number }

    expect(res.dispatched).toBe(2)
    const [, events] = step.sendEvent.mock.calls[0]
    expect(events).toEqual([
      {
        name: 'integration/hospitable.reservation_reconcile.requested',
        data: { user_id: 'u1', org_id: 'org_1', external_user_id: 'x1' },
      },
      {
        name: 'integration/hospitable.reservation_reconcile.requested',
        data: { user_id: 'u2', org_id: 'org_2', external_user_id: 'x2' },
      },
    ])
  })

  it('sends nothing when no connection is active, rather than an empty batch', async () => {
    const supabase = makeSupabase({ integration_connections: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const res = await invokeHandler(hospReservationReconcileCron, {
      event: {}, step, logger: makeLogger(),
    }) as { dispatched: number }

    expect(res.dispatched).toBe(0)
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('paginates the connection scan — a platform-wide read must not stop at max_rows', async () => {
    // The failure this pins is silent: PostgREST caps at 1000 and returns a
    // 200, so connection 1001 simply stops being reconciled while the cron
    // still reports success. fetchAllRows drains pages until one comes up
    // short, so a second page must be requested and included.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      user_id: `u${i}`, org_id: `org_${i}`, external_user_id: `x${i}`,
    }))
    const supabase = makeSupabase({
      integration_connections: [
        { data: page1, error: null },
        { data: [{ user_id: 'u_last', org_id: 'org_last', external_user_id: 'x_last' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const res = await invokeHandler(hospReservationReconcileCron, {
      event: {}, step, logger: makeLogger(),
    }) as { dispatched: number }

    expect(res.dispatched).toBe(1001)
    const [, events] = step.sendEvent.mock.calls[0] as [string, { data: { org_id: string } }[]]
    expect(events[events.length - 1].data.org_id).toBe('org_last')
  })
})

// ── The per-connection handler ──────────────────────────────────────────────

const EVENT = { data: { user_id: 'u1', org_id: 'org_1', external_user_id: 'x1' } }

/** A confirmed guest stay — the shape that is revenue-eligible. */
const CONFIRMED_RESERVATION = {
  id: 'res_missed',
  properties: [{ id: 'hosp_1' }],
  arrival_date:   '2026-09-01',
  departure_date: '2026-09-05',
  reservation_status: { current: { category: 'accepted' } },
  platform: 'airbnb',
  guests: [{ first_name: 'A', last_name: 'B' }],
}

describe('hospReservationReconcileHandler', () => {
  it('skips an org with no synced Hospitable properties instead of erroring', async () => {
    // The initial sync may still be running. Nothing to reconcile is a normal
    // state, not a failure worth retrying three times.
    const supabase = makeSupabase({ properties: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const res = await invokeHandler(hospReservationReconcileHandler, {
      event: EVENT, step: runAllStep(), logger: makeLogger(),
    }) as { skipped: boolean; reason: string }

    expect(res).toEqual({ skipped: true, reason: 'no_properties' })
    expect(fetchReservationsWindow).not.toHaveBeenCalled()
  })

  it('reads the token through the REFRESH-AWARE getter, never the raw Vault read', async () => {
    // THE 2026-08-18 401. This handler used readIntegrationToken, which returns
    // whatever is stored without checking expiry. Hospitable access tokens live
    // 12 hours; the cron fires at 10:00 UTC, and one connection's token expired
    // at 10:00:06 — the refresh cron renewed it six seconds AFTER this handler
    // had already read the stale one. GET /reservations answered
    // {"message":"Unauthenticated."} and all three retries burned on a token
    // that was dead before the first attempt.
    //
    // AND THE 2026-08-24 RECURRENCE, which is why the fixture now has a
    // property. The getter is acquired INSIDE each fetch step rather than in a
    // `step.run('read-token')` of its own — a hoisted token is memoized by
    // Inngest and replayed on every retry, so making the getter refresh-aware
    // only ever fixed a token that was already stale when read. It could not
    // help one that died AFTER the read.
    //
    // A consequence worth stating: with nothing to sync the token is never
    // acquired at all, so this asserts against an org that HAS a property.
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabase({
      properties: [{ data: [{ id: 'prop_1', external_id: 'hosp_1' }], error: null }],
    }))

    await invokeHandler(hospReservationReconcileHandler, {
      event: EVENT, step: runAllStep(), logger: makeLogger(),
    })

    expect(getValidHospitableToken).toHaveBeenCalledWith('u1')
  })

  it('is non-retriable when the token is gone — a dead credential needs a reconnect, not 3 retries a day', async () => {
    // Also needs a property: the token is acquired lazily now, so an org with
    // nothing to reconcile skips before ever reaching the credential. That is
    // the right trade — a connection that has synced always has properties, so
    // a revoked one still surfaces here, and a connection revoked before its
    // first sync has genuinely nothing to do. The reconnect notification is
    // integration-token-refresh-handler's job either way, per this file's own
    // header.
    ;(getValidHospitableToken as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabase({
      properties: [{ data: [{ id: 'prop_1', external_id: 'hosp_1' }], error: null }],
    }))

    await expect(
      invokeHandler(hospReservationReconcileHandler, {
        event: EVENT, step: runAllStep(), logger: makeLogger(),
      })
    ).rejects.toThrow(/reconnect required/i)
  })

  it('upserts a reservation that webhooks never delivered', async () => {
    // The whole point of the backstop.
    const upserts: Recorded[] = []
    const supabase = makeSupabase({
      properties: [{ data: [{ id: 'prop_1', external_id: 'hosp_1' }], error: null }],
      bookings:   [{ data: [], error: null }],
    }, upserts)
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(fetchReservationsWindow as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'res_missed',
        properties: [{ id: 'hosp_1' }],
        arrival_date:   '2026-09-01',
        departure_date: '2026-09-05',
        reservation_status: { current: { category: 'accepted' } },
        platform: 'airbnb',
        guests: [{ first_name: 'A', last_name: 'B' }],
      },
    ])

    await invokeHandler(hospReservationReconcileHandler, {
      event: EVENT, step: runAllStep(), logger: makeLogger(),
    })

    const bookingUpsert = upserts.find((u) => u.table === 'bookings')
    expect(bookingUpsert).toBeDefined()
    const rows = bookingUpsert!.rows as { external_id: string; property_id: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].external_id).toBe('res_missed')
    expect(rows[0].property_id).toBe('prop_1')
  })

  it('posts revenue for a reservation the reconcile is seeing for the first time', async () => {
    const supabase = makeSupabase({
      properties: [{ data: [{ id: 'prop_1', external_id: 'hosp_1' }], error: null }],
      bookings: [
        // 1st bookings read — the pre-upsert "which already exist" check.
        { data: [], error: null },
        // 2nd — fetch-bookings-for-revenue, after the upsert.
        { data: [{ id: 'bk_1', property_id: 'prop_1', actual_total_amount: 1234 }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(fetchReservationsWindow as ReturnType<typeof vi.fn>).mockResolvedValue([CONFIRMED_RESERVATION])

    const step = runAllStep()
    await invokeHandler(hospReservationReconcileHandler, {
      event: EVENT, step, logger: makeLogger(),
    })

    const confirmed = step.sendEvent.mock.calls.find(
      ([, events]) => Array.isArray(events) && events[0]?.name === 'booking/confirmed',
    )
    expect(confirmed, 'a reservation webhooks missed must still post its revenue').toBeDefined()
  })

  it('does NOT re-post revenue for a booking it already has — the daily-no-op trap', async () => {
    // revenueMode 'new-only'. With 'all', this cron would fire one
    // booking/confirmed per confirmed booking per org EVERY DAY forever. The
    // posts are idempotent so nothing would be double-counted, which is
    // exactly what makes it insidious: thousands of guaranteed no-op events a
    // day, indistinguishable in volume from real ones, to catch the handful
    // webhooks actually missed.
    const supabase = makeSupabase({
      properties: [{ data: [{ id: 'prop_1', external_id: 'hosp_1' }], error: null }],
      // The pre-upsert check finds it already present.
      bookings:   [{ data: [{ external_id: 'res_missed' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(fetchReservationsWindow as ReturnType<typeof vi.fn>).mockResolvedValue([CONFIRMED_RESERVATION])

    const step = runAllStep()
    await invokeHandler(hospReservationReconcileHandler, {
      event: EVENT, step, logger: makeLogger(),
    })

    const confirmed = step.sendEvent.mock.calls.find(
      ([, events]) => Array.isArray(events) && events[0]?.name === 'booking/confirmed',
    )
    expect(confirmed).toBeUndefined()
  })

  it('drops a reservation whose Hospitable property is not mapped, rather than failing the batch', async () => {
    const upserts: Recorded[] = []
    const supabase = makeSupabase({
      properties: [{ data: [{ id: 'prop_1', external_id: 'hosp_1' }], error: null }],
      bookings:   [{ data: [], error: null }],
    }, upserts)
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(fetchReservationsWindow as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'res_orphan',
        properties: [{ id: 'hosp_UNKNOWN' }],
        arrival_date:   '2026-09-01',
        departure_date: '2026-09-05',
        reservation_status: { current: { category: 'accepted' } },
        platform: 'airbnb',
      },
    ])

    const logger = makeLogger()
    await invokeHandler(hospReservationReconcileHandler, {
      event: EVENT, step: runAllStep(), logger,
    })

    expect(upserts.find((u) => u.table === 'bookings')).toBeUndefined()
    // Silently is the one thing it must not be.
    expect(logger.warn).toHaveBeenCalled()
  })
})
