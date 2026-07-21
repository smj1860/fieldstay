import { describe, it, expect, vi, beforeEach } from 'vitest'

// See financial-ledger-idempotency.test.ts for the canonical explanation of
// the allowlist-step + queue-based-supabase pattern used throughout this
// file. incremental-sync.ts is a large, multi-step, per-connection-loop
// function — rather than mock every dependency for every step, each test
// below allows only the handful of step names it actually needs to reach
// the code path under test, and picks fixture data (e.g. an empty
// getProperties() response for the "new properties" check) that makes the
// *unallowed* steps' surrounding branches short-circuit safely rather than
// dereference an unresolved step result.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/ownerrez-api', () => ({
  OwnerRezApiClient: vi.fn(),
  getRedis: vi.fn(),
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

import { ownerRezIncrementalSync } from '@/lib/inngest/functions/ownerrez/incremental-sync'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient, getRedis } from '@/lib/integrations/providers/ownerrez-api'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { RateLimitError, TokenRevokedError } from '@/lib/integrations/types'
import type { OwnerRezBooking } from '@/lib/integrations/types'
import { invokeHandler } from './test-helpers'

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

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

// Queue-based .from(table) mock (see unit/owner-portal/load-owner-portal-data.test.ts
// for the reference pattern): each call to the same table consumes the next
// queued response for that table, in call order. upsertSpy/updateSpy record
// every write for assertions on payload + conflict-target shape.
function makeSupabase(queued: QueuedByTable) {
  const counters: Record<string, number> = {}
  const upsertSpy = vi.fn()
  const updateSpy = vi.fn()
  const eqSpy     = vi.fn()

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn((column: string, value: unknown) => { eqSpy(table, column, value); return chain })
    chain.in     = vi.fn(() => chain)
    chain.neq    = vi.fn(() => chain)
    chain.order  = vi.fn(() => chain)
    chain.limit  = vi.fn(() => chain)
    chain.update = vi.fn((payload: unknown) => { updateSpy(table, payload); return chain })
    chain.upsert = vi.fn((payload: unknown, opts: unknown) => { upsertSpy(table, payload, opts); return chain })

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = vi.fn(() => resolveNext())
    chain.maybeSingle = vi.fn(() => resolveNext())
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, upsertSpy, updateSpy, eqSpy }
}

const CONN = {
  id:                'conn_1',
  user_id:           'user_1',
  org_id:            'org_1',
  external_user_id:  'ext_1',
  metadata:          { sync_cursor: '2026-07-19T10:00:00.000Z' },
}

const BOOKING: OwnerRezBooking = {
  id:            555,
  arrival:       '2026-08-01',
  departure:     '2026-08-05',
  status:        'confirmed',
  type:          'booking',
  property_id:   777,
  channel_name:  'Airbnb',
  guest:         { first_name: 'Jane', last_name: 'Doe' },
  total_amount:  500,
  charges:       [{ type: 'rent', amount: 500, owner_amount: 450 }],
}

describe('ownerRezIncrementalSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

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
      integration_connections: [{ data: [CONN], error: null }],
      properties:              [{ data: [{ id: 'prop_1', external_id: '777' }], error: null }],
      bookings:                [{ data: [{ id: 'booking_row_1', external_id: '555' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep([
      'fetch-connections',
      'check-new-properties-user_1',
      'sync-user-user_1',
      'generate-turnovers-user_1',
    ])

    const result = await invokeHandler(ownerRezIncrementalSync, {
      event:  {},
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
    const cursorUpdate = supabase.updateSpy.mock.calls.find((c) => c[0] === 'integration_connections')
    expect(cursorUpdate).toBeDefined()
    const metadata = (cursorUpdate?.[1] as { metadata: Record<string, unknown> }).metadata
    expect(metadata.sync_cursor).toBe(start.toISOString())
    expect(metadata.last_synced_at).toBe(new Date(start.getTime() + 5000).toISOString())
    expect(metadata.sync_cursor).not.toBe(metadata.last_synced_at)

    expect(generateTurnoversForProperty).toHaveBeenCalledWith('prop_1', 'org_1', supabase)
    expect(result).toEqual({ synced: 1, total: 1, rate_limited_at: null })

    vi.useRealTimers()
  })

  it('skips the bookings upsert entirely when the property lookup query fails, instead of overwriting property_id with null', async () => {
    const mockClient = baseMocks()
    mockClient.getBookings.mockResolvedValue([BOOKING])

    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN], error: null }],
      properties:              [{ data: null, error: { message: 'db timeout' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['fetch-connections', 'check-new-properties-user_1', 'sync-user-user_1'])

    const result = await invokeHandler(ownerRezIncrementalSync, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(supabase.upsertSpy).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.ownerrez-incremental-sync.property_lookup', orgId: 'org_1' }),
    )
    // The step returns before reaching the cursor-advance code at all —
    // a failed lookup must not silently mark this tick as synced.
    expect(supabase.updateSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ synced: 0, total: 1, rate_limited_at: null })
  })

  it('marks the connection revoked, fires integration/connection.error, and swallows the resulting NonRetriableError so the rest of the batch still runs', async () => {
    const mockClient = baseMocks()
    mockClient.getBookings.mockRejectedValue(new TokenRevokedError('user_1'))

    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN], error: null }],
      org_milestones:          [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['fetch-connections', 'check-new-properties-user_1', 'sync-user-user_1'])

    const result = await invokeHandler(ownerRezIncrementalSync, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(supabase.updateSpy).toHaveBeenCalledWith(
      'integration_connections',
      expect.objectContaining({ status: 'revoked' }),
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:    'org_1',
        action:   'integration.sync_failed',
        metadata: expect.objectContaining({ provider_id: 'ownerrez', reason: 'token_revoked' }),
      }),
    )
    expect(step.sendEvent).toHaveBeenCalledWith(
      'notify-revoked-connection',
      expect.objectContaining({
        name: 'integration/connection.error',
        data: expect.objectContaining({ user_id: 'user_1', org_id: 'org_1', provider_id: 'ownerrez' }),
      }),
    )
    // The per-connection loop's own try/catch swallows NonRetriableError —
    // the whole tick must not fail just because one connection's token died.
    expect(result).toEqual({ synced: 0, total: 1, rate_limited_at: null })
  })

  it('scopes fetch-connections to the triggering user_id when the event carries one (webhook/manual path)', async () => {
    baseMocks()

    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['fetch-connections', 'check-new-properties-user_1', 'sync-user-user_1'])

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
  })

  it('does not scope fetch-connections when the triggering event carries no user_id (cron sweep)', async () => {
    baseMocks()

    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['fetch-connections', 'check-new-properties-user_1', 'sync-user-user_1'])

    await invokeHandler(ownerRezIncrementalSync, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    const connectionsEqCalls = supabase.eqSpy.mock.calls.filter((c) => c[0] === 'integration_connections')
    expect(connectionsEqCalls.map((c) => c[1])).not.toContain('user_id')
  })

  it('fails fast on rate limit — no sleep, records rate_limited without flipping connection status to error', async () => {
    const mockClient = baseMocks()
    mockClient.getBookings.mockRejectedValue(new RateLimitError(45))

    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['fetch-connections', 'check-new-properties-user_1', 'sync-user-user_1'])

    const result = await invokeHandler(ownerRezIncrementalSync, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    const rateLimitUpdate = supabase.updateSpy.mock.calls.find((c) => c[0] === 'integration_connections')
    expect(rateLimitUpdate).toBeDefined()
    const payload = rateLimitUpdate?.[1] as { status?: string; metadata: Record<string, unknown> }
    expect(payload.status).toBeUndefined()
    expect(payload.metadata.last_sync_status).toBe('rate_limited')

    // The shared budget is exhausted for every tenant, not just this one —
    // sleeping and retrying within the same run would be pointless, so the
    // tick just ends. The next scheduled run picks up where this left off.
    expect(step.sleep).not.toHaveBeenCalled()
    expect(result).toEqual({ synced: 0, total: 1, rate_limited_at: 'user_1' })
  })

  it('stops processing remaining connections in the same tick once one hits the shared rate limit', async () => {
    const mockClient = baseMocks()
    mockClient.getBookings.mockRejectedValue(new RateLimitError(45))

    const CONN_2 = { ...CONN, id: 'conn_2', user_id: 'user_2', external_user_id: 'ext_2' }

    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN, CONN_2], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep([
      'fetch-connections', 'check-new-properties-user_1', 'sync-user-user_1',
      'check-new-properties-user_2', 'sync-user-user_2',
    ])

    const result = await invokeHandler(ownerRezIncrementalSync, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    // Only the first connection's sync step ever ran — the second connection
    // in the batch was never attempted once the shared budget was exhausted.
    expect(step.run).toHaveBeenCalledWith('sync-user-user_1', expect.any(Function))
    expect(step.run).not.toHaveBeenCalledWith('sync-user-user_2', expect.any(Function))
    expect(result).toEqual({ synced: 0, total: 2, rate_limited_at: 'user_1' })
  })
})
