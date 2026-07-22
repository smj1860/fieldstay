import { describe, it, expect, vi, beforeEach } from 'vitest'

// See ownerrez-incremental-sync.test.ts for the canonical explanation of the
// queue-based-supabase mock pattern used throughout this file.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/ownerrez-api', () => ({
  OwnerRezApiClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { ownerRezReviewsSync } from '@/lib/inngest/functions/ownerrez/ownerrez-reviews-sync'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient } from '@/lib/integrations/providers/ownerrez-api'
import { logAuditEvent } from '@/lib/audit'
import { RateLimitError, TokenRevokedError } from '@/lib/integrations/types'
import type { OwnerRezReview } from '@/lib/integrations/types'
import { invokeHandler } from './test-helpers'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

// Bare pass-through step — reviews-sync has no rate-limit-budget-halts-loop
// behavior (unlike incremental-sync.ts), so nothing here depends on
// selectively skipping steps; only step.sleep/sendEvent calls are asserted.
function makeStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sleep:     vi.fn(async () => undefined),
    sendEvent: vi.fn(async () => undefined),
  }
}

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

// Queue-based .from(table) mock (see checklist-broadcast.test.ts / financial-
// ledger-idempotency.test.ts): each call to the same table consumes the next
// queued response for that table, in call order.
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

function makeConn(overrides: Record<string, unknown> = {}) {
  return {
    user_id:  'user_1',
    org_id:   'org_1',
    metadata: { reviews_sync_cursor: '2026-07-01T00:00:00.000Z' },
    ...overrides,
  }
}

const REVIEW: OwnerRezReview = {
  id:            9001,
  stars:         5,
  body:          'Great place, would stay again!',
  display_name:  'Jane D.',
  date:          '2026-07-10',
  property_id:   777,
}

describe('ownerRezReviewsSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  function baseMocks(getReviewsImpl: (userId: string) => Promise<OwnerRezReview[]>) {
    // Must be a real `function`, not an arrow function — the source calls
    // `new OwnerRezApiClient(userId)`, and arrow functions can't be used as
    // constructors (see ownerrez-incremental-sync.test.ts's baseMocks()).
    ;(OwnerRezApiClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (userId: string) {
      return { getReviews: vi.fn(() => getReviewsImpl(userId)) }
    })
  }

  it('resolves property_id from the OwnerRez external id, upserts on the org+external_id+external_source conflict target, and advances the cursor to the pre-fetch timestamp', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-07-22T09:00:00.000Z')
    vi.setSystemTime(start)

    baseMocks(async () => [REVIEW])

    const supabase = makeSupabase({
      integration_connections: [
        { data: [makeConn()], error: null }, // fetch-connections
        { data: null, error: null },         // update-reviews-cursor
      ],
      properties: [{ data: [{ id: 'prop_1', external_id: '777' }], error: null }],
      reviews:    [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(ownerRezReviewsSync, {
      event:  {},
      step:   makeStep(),
      logger: makeLogger(),
    })

    // Idempotency: a redelivered event or re-run cron tick must update the
    // existing review row, never insert a duplicate.
    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'reviews',
      [
        expect.objectContaining({
          external_id:     '9001',
          external_source: 'ownerrez',
          external_url:    'https://app.ownerrez.com/reviews/9001',
          org_id:           'org_1',
          property_id:      'prop_1',
          guest_name:       'Jane D.',
          rating:           5,
          review_text:      'Great place, would stay again!',
          review_date:      '2026-07-10',
        }),
      ],
      { onConflict: 'org_id,external_id,external_source', ignoreDuplicates: false },
    )

    const cursorUpdate = supabase.updateSpy.mock.calls.find((c) => c[0] === 'integration_connections')
    expect(cursorUpdate).toBeDefined()
    const metadata = (cursorUpdate?.[1] as { metadata: Record<string, unknown> }).metadata
    expect(metadata.reviews_sync_cursor).toBe(start.toISOString())

    expect(result).toBeUndefined()
    vi.useRealTimers()
  })

  it('is a no-op when there are no active OwnerRez connections', async () => {
    baseMocks(async () => [])

    const supabase = makeSupabase({
      integration_connections: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(ownerRezReviewsSync, {
      event:  {},
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(OwnerRezApiClient).not.toHaveBeenCalled()
    expect(supabase.upsertSpy).not.toHaveBeenCalled()
    expect(supabase.updateSpy).not.toHaveBeenCalled()
    // Only fetch-connections ran — the per-connection loop body never ran.
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
  })

  it('marks the connection revoked, logs the audit event, fires a throttle-eligible PM notification, and still processes the next connection in the same tick', async () => {
    baseMocks(async (userId) => {
      if (userId === 'user_1') throw new TokenRevokedError(userId)
      return []
    })

    const supabase = makeSupabase({
      integration_connections: [
        { data: [makeConn(), makeConn({ user_id: 'user_2', org_id: 'org_2', metadata: {} })], error: null }, // fetch-connections
        { data: { id: 'conn_1', metadata: {} }, error: null }, // mark-revoked existing select
        { data: null, error: null },                            // mark-revoked update
        { data: null, error: null },                            // cursor update for user_2 (empty reviews still advances cursor)
      ],
      org_milestones: [
        { data: null, error: null }, // no recent notification — not throttled
        { data: null, error: null }, // upsert notified_at marker
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(ownerRezReviewsSync, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(supabase.updateSpy).toHaveBeenCalledWith(
      'integration_connections',
      expect.objectContaining({
        status:   'revoked',
        metadata: expect.objectContaining({ last_sync_status: 'error' }),
      }),
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:      'org_1',
        actorId:    'user_1',
        action:     'integration.sync_failed',
        targetType: 'integration_connection',
        targetId:   'ownerrez',
        metadata:   expect.objectContaining({ provider_id: 'ownerrez', reason: 'token_revoked' }),
      }),
    )
    expect(step.sendEvent).toHaveBeenCalledWith(
      'notify-revoked-user_1',
      expect.objectContaining({
        name: 'integration/connection.error',
        data: expect.objectContaining({ user_id: 'user_1', org_id: 'org_1', provider_id: 'ownerrez' }),
      }),
    )
    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'org_milestones',
      expect.objectContaining({ org_id: 'org_1', milestone: 'integration_error_notified:conn_1' }),
      { onConflict: 'org_id,milestone' },
    )

    // The revoked connection's own failure must not abort the tick — the
    // next connection in the loop is still constructed and processed.
    expect(OwnerRezApiClient).toHaveBeenCalledWith('user_2')
    expect(result).toBeUndefined()
  })

  it('throttles the revoked-connection PM notification to once per 4 hours — no duplicate send when one was recorded an hour ago', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-07-22T09:00:00.000Z')
    vi.setSystemTime(now)
    const recentNotifiedAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString() // 1h ago

    baseMocks(async () => { throw new TokenRevokedError('user_1') })

    const supabase = makeSupabase({
      integration_connections: [
        { data: [makeConn()], error: null },
        { data: { id: 'conn_1', metadata: {} }, error: null },
        { data: null, error: null },
      ],
      org_milestones: [
        { data: { value: { notified_at: recentNotifiedAt }, achieved_at: recentNotifiedAt }, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    await invokeHandler(ownerRezReviewsSync, { event: {}, step, logger: makeLogger() })

    expect(step.sendEvent).not.toHaveBeenCalled()
    // The throttle-marker upsert lives inside the same `if (!tooSoon)` guard
    // as the notification send — neither should fire when throttled.
    expect(supabase.upsertSpy).not.toHaveBeenCalledWith('org_milestones', expect.anything(), expect.anything())

    vi.useRealTimers()
  })

  it('isolates a generic per-connection fetch failure — records the error on that connection and still processes the next one', async () => {
    baseMocks(async (userId) => {
      if (userId === 'user_1') throw new Error('boom')
      return []
    })

    const supabase = makeSupabase({
      integration_connections: [
        { data: [makeConn(), makeConn({ user_id: 'user_2', org_id: 'org_2', metadata: {} })], error: null },
        { data: null, error: null }, // record-reviews-sync-error for user_1
        { data: null, error: null }, // cursor update for user_2
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(ownerRezReviewsSync, {
      event:  {},
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(supabase.updateSpy).toHaveBeenCalledWith(
      'integration_connections',
      expect.objectContaining({
        metadata: expect.objectContaining({
          last_reviews_sync_status: 'error',
          last_reviews_sync_error:  'Sync failed — will retry automatically',
        }),
      }),
    )
    expect(OwnerRezApiClient).toHaveBeenCalledWith('user_2')
    expect(result).toBeUndefined()
  })

  it('sleeps and retries once on a rate limit, then proceeds normally with the retried reviews', async () => {
    let call = 0
    baseMocks(async () => {
      call += 1
      if (call === 1) throw new RateLimitError(30)
      return [REVIEW]
    })

    const supabase = makeSupabase({
      integration_connections: [
        { data: [makeConn()], error: null },
        { data: null, error: null }, // cursor update
      ],
      properties: [{ data: [{ id: 'prop_1', external_id: '777' }], error: null }],
      reviews:    [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    await invokeHandler(ownerRezReviewsSync, { event: {}, step, logger: makeLogger() })

    expect(step.sleep).toHaveBeenCalledWith('rate-limit-sleep-user_1', '30s')
    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'reviews',
      expect.arrayContaining([expect.objectContaining({ external_id: '9001' })]),
      expect.anything(),
    )
  })
})
