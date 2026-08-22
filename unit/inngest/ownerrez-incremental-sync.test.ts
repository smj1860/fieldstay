import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// See financial-ledger-idempotency.test.ts for the canonical explanation of
// the allowlist-step + queue-based-supabase pattern used throughout this
// file. The incremental sync is split into a dispatcher (fan-out) and a
// per-connection handler — each test below allows only the handful of step
// names it actually needs to reach the code path under test.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/ownerrez-api', () => ({
  OwnerRezApiClient: vi.fn(),
}))
// The Redis client moved to lib/redis.ts, the app's single construction site.
// upstashConfigured() defaults to TRUE here so the existing breaker tests keep
// exercising the Redis path; the preview/unconfigured behaviour has its own
// describe block at the end of this file.
vi.mock('@/lib/redis', () => ({
  getRedis:            vi.fn(),
  upstashConfigured:   vi.fn(() => true),
  getRedisIfConfigured: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))
vi.mock('@/lib/turnovers/generator', () => ({
  generateTurnoversForProperty: vi.fn(),
  cancelTurnoversForBooking: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(),
}))
vi.mock('@/lib/maintenance/vacancy-suggestions', () => ({
  findMaintenanceCandidatesForWindow: vi.fn(),
}))
vi.mock('@/lib/guidebook/sync', () => ({
  createGuidebookPropertyConfigsForProperties: vi.fn(),
}))
vi.mock('@/lib/asset-discovery/seed-from-amenities', () => ({
  seedPresentAssetsFromAmenities: vi.fn(),
}))
// Mocked so notifyConnectionErrorThrottled's inngest.send() is assertable
// (and never attempts a real network call). createFunction returns the raw
// handler in the same `{ fn }` shape invokeHandler expects.
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((_opts: unknown, _trigger: unknown, fn: unknown) => ({ fn })),
    send: vi.fn(async () => undefined),
  },
}))

import { ownerRezIncrementalSync, ownerRezConnectionSync } from '@/lib/inngest/functions/ownerrez/incremental-sync'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient } from '@/lib/integrations/providers/ownerrez-api'
import { getRedis, upstashConfigured } from '@/lib/redis'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { RateLimitError, TokenRevokedError } from '@/lib/integrations/types'
import type { OwnerRezBooking } from '@/lib/integrations/types'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function makeAllowlistStep(allowed: string[]) {
  return {
    run: vi.fn((name: string, cb: () => unknown) => (allowed.includes(name) ? cb() : Promise.resolve(undefined))),
    sleep: vi.fn(async () => undefined),
    sendEvent: vi.fn(async () => undefined),
  }
}


// Queue-based .from(table) mock (see unit/owner-portal/load-owner-portal-data.test.ts
// for the reference pattern): each call to the same table consumes the next
// queued response for that table, in call order. upsertSpy/updateSpy record
// every write for assertions on payload + conflict-target shape.
// The ONE shared query-builder double, not a local hand-roll — its
// eqSpy / updateSpy / upsertSpy carry the same (table, ...args) convention the
// assertions below already used, and `supabase.rpc` IS the rpc spy. The local
// version broke the moment this function's connection read was paginated onto
// .order().range(); that divergence is what the shared stub exists to end. It
// also paginates for real, so a >1000-connection fixture is genuinely walked.
const makeSupabase = (tables: Record<string, TableSpec>) =>
  createSupabaseDouble(tables, { rpc: { data: {}, error: null } })

/** Finds the merge_integration_connection_metadata RPC call whose p_patch contains `key`. */
function findMetadataMergeCall(rpcSpy: ReturnType<typeof vi.fn>, key: string) {
  return rpcSpy.mock.calls.find(
    (c) =>
      c[0] === 'merge_integration_connection_metadata' &&
      (c[1] as { p_patch?: Record<string, unknown> }).p_patch?.[key] !== undefined,
  )
}

const CONN_ROW = {
  id:                'conn_1',
  user_id:           'user_1',
  org_id:            'org_1',
  external_user_id:  'ext_1',
  metadata:          { sync_cursor: '2026-07-19T10:00:00.000Z' },
  status:            'active',
}

const SYNC_EVENT = {
  data: {
    connection_id:        'conn_1',
    user_id:              'user_1',
    org_id:               'org_1',
    external_user_id:     'ext_1',
    check_new_properties: false,
  },
}

const BOOKING: OwnerRezBooking = {
  id:            555,
  arrival:       '2026-08-01',
  departure:     '2026-08-05',
  status:        'confirmed',
  type:          'booking',
  property_id:   777,
  listing_site:  'Airbnb',
  guest:         { first_name: 'Jane', last_name: 'Doe' },
  total_amount:  500,
  charges:       [{ type: 'rent', amount: 500, owner_amount: 450 }],
}

function baseMocks() {
  const mockClient = {
    getProperties: vi.fn().mockResolvedValue([]),
    getBookings:   vi.fn().mockResolvedValue([]),
  }
  ;(OwnerRezApiClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
    return mockClient
  })
  ;(getRedis as ReturnType<typeof vi.fn>).mockReturnValue({
    get:    vi.fn().mockResolvedValue(0),
    del:    vi.fn().mockResolvedValue(undefined),
    incr:   vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(undefined),
  })
  return mockClient
}

describe('ownerRezIncrementalSync (dispatcher)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('fans out one connection.sync.requested event per active connection (cron sweep, unscoped)', async () => {
    baseMocks()
    // 13:00 UTC ≠ the daily 10:00 UTC diff hour → the cron does NOT request
    // the getProperties() new-property diff on this tick (discovery is
    // webhook-primary; the cron diff is a once-daily backstop).
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T13:00:00.000Z'))

    const CONN_2 = { ...CONN_ROW, id: 'conn_2', user_id: 'user_2', external_user_id: 'ext_2' }
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_ROW, CONN_2], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['filter-open-circuits', 'fetch-connections'])
    const result = await invokeHandler(ownerRezIncrementalSync, { event: {}, step, logger: makeLogger() })

    expect(result).toEqual({ dispatched: 2 })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-connection-syncs', [
      expect.objectContaining({
        name: 'ownerrez/connection.sync.requested',
        data: expect.objectContaining({ connection_id: 'conn_1', user_id: 'user_1', check_new_properties: false }),
      }),
      expect.objectContaining({
        name: 'ownerrez/connection.sync.requested',
        data: expect.objectContaining({ connection_id: 'conn_2', user_id: 'user_2', check_new_properties: false }),
      }),
    ])
    // Unscoped sweep — no user_id filter on the connections query
    const connectionsEqCalls = supabase.eqSpy.mock.calls.filter((c) => c[0] === 'integration_connections')
    expect(connectionsEqCalls.map((c) => c[1])).not.toContain('user_id')

    vi.useRealTimers()
  })

  it('requests the new-property diff on the daily backstop tick (10:00 UTC)', async () => {
    baseMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T10:00:00.000Z'))

    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_ROW], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['filter-open-circuits', 'fetch-connections'])
    await invokeHandler(ownerRezIncrementalSync, { event: {}, step, logger: makeLogger() })

    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-connection-syncs', [
      expect.objectContaining({
        data: expect.objectContaining({ check_new_properties: true }),
      }),
    ])

    vi.useRealTimers()
  })

  it('scopes to the triggering user_id and always requests the new-property diff on scoped runs', async () => {
    baseMocks()
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_ROW], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['filter-open-circuits', 'fetch-connections'])
    await invokeHandler(ownerRezIncrementalSync, {
      event: {
        data: {
          provider_id: 'ownerrez', event_type: 'entity_update', entity_type: 'booking',
          entity_id: '555', triggered_at: '2026-07-20T10:00:00.000Z', correlation_id: null,
          user_id: 'user_1', org_id: 'org_1',
        },
      },
      step,
      logger: makeLogger(),
    })

    expect(supabase.eqSpy).toHaveBeenCalledWith('integration_connections', 'user_id', 'user_1')
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-connection-syncs', [
      expect.objectContaining({
        data: expect.objectContaining({ check_new_properties: true }),
      }),
    ])
  })

  // ── The breaker is PER CONNECTION ───────────────────────────────────────
  //
  // This block replaces a test asserting the whole tick was skipped when "the"
  // breaker was open. There was one global key,
  // 'ownerrez:circuit:consecutive_failures', shared by every tenant, and
  // recordCircuitFailure() is called from handleConnectionSyncFailure — a
  // PER-CONNECTION handler. So one org's expired token incremented the shared
  // counter hourly and, at the threshold, stopped EVERY org from syncing for
  // up to the key's 30-minute TTL.
  //
  // The same key was wrong in the other direction too: resetCircuitBreaker()
  // does redis.del() on any connection's success, and connections fan out
  // concurrently — so one healthy org wiped failures nine failing orgs had
  // just recorded, and a degraded-but-not-dead API could never trip the
  // breaker at all.

  it('skips only the connection whose breaker is open and still dispatches the healthy ones', async () => {
    baseMocks()
    ;(getRedis as ReturnType<typeof vi.fn>).mockReturnValue({
      // conn_1 is over the threshold; conn_2 is clean.
      get: vi.fn(async (key: string) => (key === 'ownerrez:circuit:conn_1' ? 10 : 0)),
    })
    const CONN_2 = { ...CONN_ROW, id: 'conn_2', user_id: 'user_2', external_user_id: 'ext_2' }
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_ROW, CONN_2], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['filter-open-circuits', 'fetch-connections'])
    const result = await invokeHandler(ownerRezIncrementalSync, { event: {}, step, logger: makeLogger() })

    // The whole point: user_1's broken connection must not cost user_2 a sync.
    expect(result).toEqual({ dispatched: 1 })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-connection-syncs', [
      expect.objectContaining({
        data: expect.objectContaining({ connection_id: 'conn_2' }),
      }),
    ])
  })

  it('skips the tick only when EVERY connection has an open breaker', async () => {
    baseMocks()
    ;(getRedis as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockResolvedValue(10),
    })
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_ROW], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['filter-open-circuits', 'fetch-connections'])
    const result = await invokeHandler(ownerRezIncrementalSync, { event: {}, step, logger: makeLogger() })

    expect(result).toEqual({ dispatched: 0, circuit_open: true })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('reads a breaker key scoped to the connection id, not a shared one', async () => {
    baseMocks()
    const get = vi.fn().mockResolvedValue(0)
    ;(getRedis as ReturnType<typeof vi.fn>).mockReturnValue({ get })
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_ROW], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['filter-open-circuits', 'fetch-connections'])
    await invokeHandler(ownerRezIncrementalSync, { event: {}, step, logger: makeLogger() })

    expect(get).toHaveBeenCalledWith('ownerrez:circuit:conn_1')
    expect(get).not.toHaveBeenCalledWith('ownerrez:circuit:consecutive_failures')
  })

  // Audit 2026-07-30: every breaker Redis call sat in `catch { /* non-fatal */ }`,
  // so during a Redis outage the counter never moved, the breaker never
  // opened, and each tick kept dispatching syncs into a failing API. Same
  // reasoning as CLAUDE.md's SMS spend ceiling: a protective limit must not
  // disappear during an outage.
  it('falls back to the in-memory failure count (and reports) when Redis cannot be read', async () => {
    baseMocks()
    ;(getRedis as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockRejectedValue(new Error('redis unreachable')),
    })
    // One connection, so the per-connection breaker read actually happens.
    const supabase = makeSupabase({ integration_connections: [{ data: [CONN_ROW], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const logger = makeLogger()
    const step   = makeAllowlistStep(['filter-open-circuits', 'fetch-connections'])
    await invokeHandler(ownerRezIncrementalSync, { event: {}, step, logger })

    // Never swallowed: the operator can see the breaker is running degraded.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Circuit-breaker state unreadable'))
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.ownerrez-incremental-sync.circuit_breaker_read' }),
    )
  })
})

describe('ownerRezConnectionSync (per-connection handler)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('resolves property_id from the OwnerRez external id, upserts bookings on the org+external_id+external_source conflict target, and advances sync_cursor using the pre-fetch timestamp', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-07-20T10:00:00.000Z')
    vi.setSystemTime(start)

    const mockClient = baseMocks()
    mockClient.getBookings.mockImplementation(async () => {
      // Simulate the fetch taking real wall-clock time — proves the code
      // uses the timestamp captured BEFORE this call, not after.
      vi.setSystemTime(new Date(start.getTime() + 5000))
      return [BOOKING]
    })
    ;(generateTurnoversForProperty as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const supabase = makeSupabase({
      integration_connections: [{ data: CONN_ROW, error: null }],
      properties:              [{ data: [{ id: 'prop_1', external_id: '777' }], error: null }],
      bookings:                [{ data: [{ id: 'booking_row_1', external_id: '555' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep([
      'check-circuit-breaker',
      'sync-connection',
      'generate-turnovers',
    ])

    const result = await invokeHandler(ownerRezConnectionSync, {
      event:  SYNC_EVENT,
      step,
      logger: makeLogger(),
    })

    // Idempotency: the bookings upsert must use the tenant-scoped unique
    // conflict target — a redelivered webhook or re-run cron tick must
    // update the existing row, never insert a duplicate booking.
    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'bookings',
      expect.arrayContaining([expect.objectContaining({ external_id: '555', property_id: 'prop_1' })]),
      { onConflict: 'org_id,external_id,external_source' },
    )

    // Cursor correctness: sync_cursor must be the PRE-fetch timestamp, not
    // last_synced_at (post-fetch) — using the post-fetch value would miss
    // any booking modified upstream during the fetch window.
    const cursorMergeCall = findMetadataMergeCall(supabase.rpc, 'sync_cursor')
    expect(cursorMergeCall).toBeDefined()
    const patch = (cursorMergeCall?.[1] as { p_patch: Record<string, unknown> }).p_patch
    expect(patch.sync_cursor).toBe(start.toISOString())
    expect(patch.last_synced_at).toBe(new Date(start.getTime() + 5000).toISOString())
    expect(patch.sync_cursor).not.toBe(patch.last_synced_at)

    expect(generateTurnoversForProperty).toHaveBeenCalledWith('prop_1', 'org_1', supabase)
    expect(result).toEqual({ connectionId: 'conn_1', synced: true, backfill: 'skipped' })

    vi.useRealTimers()
  })

  it('skips cleanly when the connection is no longer active at run time', async () => {
    baseMocks()
    const supabase = makeSupabase({
      integration_connections: [{ data: { ...CONN_ROW, status: 'revoked' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['check-circuit-breaker', 'sync-connection'])
    const result = await invokeHandler(ownerRezConnectionSync, { event: SYNC_EVENT, step, logger: makeLogger() })

    expect(supabase.upsertSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ connectionId: 'conn_1', synced: false, backfill: 'skipped' })
  })

  it('skips the bookings upsert entirely when the property lookup query fails, instead of overwriting property_id with null', async () => {
    const mockClient = baseMocks()
    mockClient.getBookings.mockResolvedValue([BOOKING])

    const supabase = makeSupabase({
      integration_connections: [{ data: CONN_ROW, error: null }],
      properties:              [{ data: null, error: { message: 'db timeout' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['check-circuit-breaker', 'sync-connection'])
    const result = await invokeHandler(ownerRezConnectionSync, { event: SYNC_EVENT, step, logger: makeLogger() })

    expect(supabase.upsertSpy).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.ownerrez-connection-sync.property_lookup', orgId: 'org_1' }),
    )
    // The step returns before reaching the cursor-advance code at all —
    // a failed lookup must not silently mark this run as synced.
    expect(supabase.updateSpy).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ connectionId: 'conn_1', synced: false, backfill: 'skipped' })
  })

  it('marks the connection revoked, fires integration/connection.error, and surfaces a non-retriable failure', async () => {
    const mockClient = baseMocks()
    mockClient.getBookings.mockRejectedValue(new TokenRevokedError('user_1', 'provider_rejected'))

    const supabase = makeSupabase({
      integration_connections: [{ data: CONN_ROW, error: null }],
      org_milestones:          [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['check-circuit-breaker', 'sync-connection'])

    // With one connection per run there is no batch to protect — the
    // NonRetriableError propagates so Inngest records a distinct
    // non-retriable failure for exactly this connection.
    await expect(
      invokeHandler(ownerRezConnectionSync, { event: SYNC_EVENT, step, logger: makeLogger() })
    ).rejects.toThrow()

    expect(supabase.rpc).toHaveBeenCalledWith(
      'merge_integration_connection_metadata',
      expect.objectContaining({ p_status: 'revoked' }),
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:    'org_1',
        action:   'integration.sync_failed',
        metadata: expect.objectContaining({ provider_id: 'ownerrez', reason: 'token_revoked' }),
      }),
    )
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'integration/connection.error',
        data: expect.objectContaining({ user_id: 'user_1', org_id: 'org_1', provider_id: 'ownerrez' }),
      }),
    )
  })

  it('on rate limit: records rate_limited without flipping status, then rethrows so Inngest retries with backoff', async () => {
    const mockClient = baseMocks()
    mockClient.getBookings.mockRejectedValue(new RateLimitError(45))

    const supabase = makeSupabase({
      integration_connections: [{ data: CONN_ROW, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['check-circuit-breaker', 'sync-connection'])

    // The rethrow is the whole point: this connection resumes on its own
    // via Inngest backoff once the 5-minute budget window rolls, instead of
    // the old serial loop's break-the-whole-tick behavior that parked every
    // other tenant until the next hourly cron.
    await expect(
      invokeHandler(ownerRezConnectionSync, { event: SYNC_EVENT, step, logger: makeLogger() })
    ).rejects.toThrow()

    // The transient status is written via the atomic metadata merge with
    // NO status change — rate-limited must not flip the connection to error.
    const rateLimitMergeCall = findMetadataMergeCall(supabase.rpc, 'last_sync_status')
    expect(rateLimitMergeCall).toBeDefined()
    // p_status is DEFAULT NULL with COALESCE(p_status, status) server-side, so
    // OMITTING it is how "leave the status alone" is expressed — the same
    // meaning the explicit null used to carry, and what the generated
    // `p_status?: string` arg type accepts.
    const payload = rateLimitMergeCall?.[1] as { p_status?: string; p_patch: Record<string, unknown> }
    expect(payload).not.toHaveProperty('p_status')
    expect(payload.p_patch.last_sync_status).toBe('rate_limited')
    expect(step.sleep).not.toHaveBeenCalled()
  })

  it('skips when the circuit breaker opened after dispatch', async () => {
    baseMocks()
    ;(getRedis as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockResolvedValue(10),
    })
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['check-circuit-breaker', 'sync-connection'])
    const result = await invokeHandler(ownerRezConnectionSync, { event: SYNC_EVENT, step, logger: makeLogger() })

    expect(result).toEqual({ skipped: 'circuit_open' })
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Upstash unconfigured (every preview deploy — the free plan is
// production-only).
//
// `new Redis({ url: undefined!, token: undefined! })` constructs happily and
// only fails at request time, building "/pipeline" as the URL and throwing
// `TypeError: Failed to parse URL from /pipeline`. The breaker called Redis
// three times per connection per tick regardless of whether Upstash existed,
// and each failure was caught, logged AND reported — 590 Sentry events across
// four days (CUSHION-D/E/H) from a condition known at boot.
//
// "Redis is DOWN" and "Redis was never CONFIGURED" are different states. The
// degraded behaviour is identical (the in-memory counter is the documented
// fallback either way); only the noise differs. The tests above cover the
// outage path and must keep reporting. These cover the configured-away path
// and must NOT.
// ============================================================================
describe('ownerRezIncrementalSync — Upstash not configured (preview)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(upstashConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false)
  })

  afterEach(() => {
    ;(upstashConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true)
  })

  it('never touches Redis at all', async () => {
    baseMocks()
    const get = vi.fn()
    ;(getRedis as ReturnType<typeof vi.fn>).mockReturnValue({ get })
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_ROW], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['filter-open-circuits', 'fetch-connections'])
    await invokeHandler(ownerRezIncrementalSync, { event: {}, step, logger: makeLogger() })

    expect(getRedis).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  it('reports NOTHING to Sentry — this is the 590-event bug', async () => {
    baseMocks()
    ;(getRedis as ReturnType<typeof vi.fn>).mockReturnValue({ get: vi.fn() })
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_ROW], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['filter-open-circuits', 'fetch-connections'])
    await invokeHandler(ownerRezIncrementalSync, { event: {}, step, logger: makeLogger() })

    expect(reportError).not.toHaveBeenCalled()
  })

  it('still dispatches the sync — an absent cache must not look like an open circuit', async () => {
    baseMocks()
    ;(getRedis as ReturnType<typeof vi.fn>).mockReturnValue({ get: vi.fn() })
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_ROW], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['filter-open-circuits', 'fetch-connections'])
    const result = await invokeHandler(ownerRezIncrementalSync, { event: {}, step, logger: makeLogger() })

    // The dispatcher only returns circuit_open when it short-circuits; a
    // normal run reports what it dispatched.
    expect(result).toEqual({ dispatched: 1 })
    expect(step.sendEvent).toHaveBeenCalled()
  })
})


// ============================================================================
// Progressive historical backfill.
//
// The initial sync deliberately fetches only a recent window (it used to ask
// for a portfolio's entire history in one step, which was survivable only
// because the pager stopped at 20 records). This walks the rest backwards, one
// stay-date window per run, using OwnerRez's from/to bounds.
//
// The planner's arithmetic is covered in unit/integrations/ownerrez-backfill.test.ts;
// what is checked HERE is the wiring — that a window actually reaches
// getBookings as from/to, that progress is persisted so the next run advances,
// and that a failure cannot either fail the live sync or skip a window silently.
// ============================================================================
describe('ownerRezConnectionSync — historical backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T12:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  const backfillStep = () => makeAllowlistStep([
    'check-circuit-breaker',
    'sync-connection',
    'backfill-history',
  ])

  /** Connection rows: one for the live sync's reload, one for the backfill's. */
  const connRows = (metadata: Record<string, unknown>) => ([
    { data: { ...CONN_ROW, metadata }, error: null },
    { data: { ...CONN_ROW, metadata }, error: null },
  ])

  it('asks OwnerRez for a STAY-DATE window, not a modification-time cursor', async () => {
    // since_utc cannot reach back through history at all — an old booking that
    // never changed has no recent modification time. This is the whole reason
    // the backfill exists as a separate call.
    const mockClient = baseMocks()
    const supabase = makeSupabase({
      integration_connections: connRows({ sync_cursor: '2026-08-01T00:00:00.000Z' }),
      properties:              [
        { data: [{ external_id: '777' }], error: null },
        { data: [{ external_id: '777' }], error: null },
      ],
      bookings:                [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(ownerRezConnectionSync, {
      event: SYNC_EVENT, step: backfillStep(), logger: makeLogger(),
    })

    const backfillCall = mockClient.getBookings.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((a) => a.from !== undefined)

    expect(backfillCall).toBeDefined()
    // 90 days of history from the initial sync, then the next 90 back.
    expect(backfillCall).toMatchObject({ to: '2026-05-15', from: '2026-02-14' })
    expect(backfillCall?.sinceUtc).toBeUndefined()
  })

  it('persists progress so the next run claims an OLDER window', async () => {
    // Without this write the walk re-fetches the same window forever.
    const supabase = makeSupabase({
      integration_connections: connRows({
        sync_cursor: '2026-08-01T00:00:00.000Z',
        backfill_oldest_covered: '2026-02-14',
      }),
      properties: [
        { data: [{ external_id: '777' }], error: null },
        { data: [{ external_id: '777' }], error: null },
      ],
      bookings:   [{ data: [], error: null }],
    })
    baseMocks()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(ownerRezConnectionSync, {
      event: SYNC_EVENT, step: backfillStep(), logger: makeLogger(),
    })

    const merge = findMetadataMergeCall(supabase.rpc, 'backfill_oldest_covered')
    expect(merge).toBeDefined()
    const patch = (merge?.[1] as { p_patch: Record<string, unknown> }).p_patch
    expect(patch.backfill_oldest_covered).toBe('2025-11-16')
    expect(patch.backfill_complete).toBe(false)
  })

  it('stops for good once the walk is marked complete', async () => {
    const mockClient = baseMocks()
    const supabase = makeSupabase({
      integration_connections: connRows({
        sync_cursor: '2026-08-01T00:00:00.000Z',
        backfill_complete: true,
      }),
      properties: [{ data: [{ external_id: '777' }], error: null }],
      bookings:   [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(ownerRezConnectionSync, {
      event: SYNC_EVENT, step: backfillStep(), logger: makeLogger(),
    })

    expect(result).toMatchObject({ backfill: 'complete' })
    expect(mockClient.getBookings.mock.calls.every((c) => (c[0] as Record<string, unknown>).from === undefined))
      .toBe(true)
  })

  it('does NOT advance progress when the window fetch fails', async () => {
    // Advancing on failure would skip that window permanently — nothing
    // revisits it. Retrying the same window next hour is the correct cost.
    const mockClient = baseMocks()
    mockClient.getBookings.mockImplementation(async (args: Record<string, unknown>) => {
      if (args?.from) throw new Error('OwnerRez 500')
      return []
    })
    const supabase = makeSupabase({
      integration_connections: connRows({ sync_cursor: '2026-08-01T00:00:00.000Z' }),
      properties: [
        { data: [{ external_id: '777' }], error: null },
        { data: [{ external_id: '777' }], error: null },
      ],
      bookings:   [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(ownerRezConnectionSync, {
      event: SYNC_EVENT, step: backfillStep(), logger: makeLogger(),
    })

    expect(findMetadataMergeCall(supabase.rpc, 'backfill_oldest_covered')).toBeUndefined()
    // And the LIVE sync still succeeded — backfill is catch-up work behind it,
    // never a reason to turn an otherwise-healthy hourly run red.
    expect(result).toMatchObject({ synced: true, backfill: 'failed' })
    expect(reportError).toHaveBeenCalled()
  })
})
