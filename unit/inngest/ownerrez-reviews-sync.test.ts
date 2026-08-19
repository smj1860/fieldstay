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

import { ownerRezReviewsSync, ownerRezReviewsSyncConnection } from '@/lib/inngest/functions/ownerrez/ownerrez-reviews-sync'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient } from '@/lib/integrations/providers/ownerrez-api'
import { logAuditEvent } from '@/lib/audit'
import { RateLimitError, TokenRevokedError } from '@/lib/integrations/types'
import type { OwnerRezReview } from '@/lib/integrations/types'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

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


// Queue-based .from(table) mock (see checklist-broadcast.test.ts / financial-
// ledger-idempotency.test.ts): each call to the same table consumes the next
// queued response for that table, in call order.
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

function makeConn(overrides: Record<string, unknown> = {}) {
  return {
    user_id:  'user_1',
    org_id:   'org_1',
    metadata: { reviews_sync_cursor: '2026-07-01T00:00:00.000Z' },
    ...overrides,
  }
}

/** The per-connection handler's trigger. */
function connEvent(userId = 'user_1', orgId = 'org_1') {
  return { data: { user_id: userId, org_id: orgId } }
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
        { data: makeConn(), error: null }, // load-sync-cursor
      ],
      properties: [{ data: [{ id: 'prop_1', external_id: '777' }], error: null }],
      reviews:    [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(ownerRezReviewsSyncConnection, {
      event:  connEvent(),
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

    const cursorMergeCall = findMetadataMergeCall(supabase.rpc, 'reviews_sync_cursor')
    expect(cursorMergeCall).toBeDefined()
    const patch = (cursorMergeCall?.[1] as { p_patch: Record<string, unknown> }).p_patch
    expect(patch.reviews_sync_cursor).toBe(start.toISOString())

    expect(result).toMatchObject({ user_id: 'user_1', status: 'ok' })
    vi.useRealTimers()
  })

  it('marks the connection revoked, logs the audit event, and fires a throttle-eligible PM notification', async () => {
    baseMocks(async (userId) => {
      if (userId === 'user_1') throw new TokenRevokedError(userId, 'provider_rejected')
      return []
    })

    const supabase = makeSupabase({
      integration_connections: [
        { data: makeConn(), error: null },       // load-sync-cursor
        { data: { id: 'conn_1' }, error: null }, // mark-revoked existing select
      ],
      org_milestones: [
        { data: null, error: null }, // no recent notification — not throttled
        { data: null, error: null }, // upsert notified_at marker
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(ownerRezReviewsSyncConnection, {
      event:  connEvent(),
      step,
      logger: makeLogger(),
    })

    expect(supabase.rpc).toHaveBeenCalledWith(
      'merge_integration_connection_metadata',
      expect.objectContaining({
        p_status: 'revoked',
        p_patch:  expect.objectContaining({ last_sync_status: 'error' }),
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

    // One connection per run now, so a revoked one cannot abort anyone else's
    // sync by construction — it ends its OWN run and reports why.
    expect(result).toMatchObject({ user_id: 'user_1', status: 'revoked' })
  })

  it('throttles the revoked-connection PM notification to once per 4 hours — no duplicate send when one was recorded an hour ago', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-07-22T09:00:00.000Z')
    vi.setSystemTime(now)
    const recentNotifiedAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString() // 1h ago

    baseMocks(async () => { throw new TokenRevokedError('user_1', 'provider_rejected') })

    const supabase = makeSupabase({
      integration_connections: [
        { data: makeConn(), error: null },
        { data: { id: 'conn_1' }, error: null },
      ],
      org_milestones: [
        { data: { value: { notified_at: recentNotifiedAt }, achieved_at: recentNotifiedAt }, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    await invokeHandler(ownerRezReviewsSyncConnection, { event: connEvent(), step, logger: makeLogger() })

    expect(step.sendEvent).not.toHaveBeenCalled()
    // The throttle-marker upsert lives inside the same `if (!tooSoon)` guard
    // as the notification send — neither should fire when throttled.
    expect(supabase.upsertSpy).not.toHaveBeenCalledWith('org_milestones', expect.anything(), expect.anything())

    vi.useRealTimers()
  })

  it('records a generic fetch failure on the connection rather than throwing it away or re-throwing', async () => {
    baseMocks(async (userId) => {
      if (userId === 'user_1') throw new Error('boom')
      return []
    })

    const supabase = makeSupabase({
      integration_connections: [
        { data: makeConn(), error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(ownerRezReviewsSyncConnection, {
      event:  connEvent(),
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(supabase.rpc).toHaveBeenCalledWith(
      'merge_integration_connection_metadata',
      expect.objectContaining({
        p_user_id: 'user_1',
        p_patch:   expect.objectContaining({
          last_reviews_sync_status: 'error',
          last_reviews_sync_error:  'Sync failed — will retry automatically',
        }),
      }),
    )
    expect(result).toMatchObject({ user_id: 'user_1', status: 'error' })
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
        { data: makeConn(), error: null },
      ],
      properties: [{ data: [{ id: 'prop_1', external_id: '777' }], error: null }],
      reviews:    [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    await invokeHandler(ownerRezReviewsSyncConnection, { event: connEvent(), step, logger: makeLogger() })

    // This sleep used to sit inside a loop over EVERY connection on the
    // platform, so one throttled tenant put the whole run to sleep and stalled
    // everyone queued behind it. It now sleeps only this connection's run.
    expect(step.sleep).toHaveBeenCalledWith('rate-limit-sleep-user_1', '30s')
    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'reviews',
      expect.arrayContaining([expect.objectContaining({ external_id: '9001' })]),
      expect.anything(),
    )
  })
})

describe('ownerRezReviewsSync (dispatcher)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('fans out one event per active connection and touches no provider API itself', async () => {
    const conns = [
      { user_id: 'user_1', org_id: 'org_1' },
      { user_id: 'user_2', org_id: 'org_2' },
    ]
    const supabase = makeSupabase({ integration_connections: [{ data: conns, error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(ownerRezReviewsSync, {
      event: { name: 'inngest/scheduled.timer' }, step, logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 2, trigger: 'cron' })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-reviews-sync', [
      { name: 'integration/ownerrez_reviews.connection_requested', data: { user_id: 'user_1', org_id: 'org_1' } },
      { name: 'integration/ownerrez_reviews.connection_requested', data: { user_id: 'user_2', org_id: 'org_2' } },
    ])
    expect(OwnerRezApiClient).not.toHaveBeenCalled()
    expect(step.sleep).not.toHaveBeenCalled()
  })

  it('dispatches ONLY the connection that fired integration/ownerrez.connected', async () => {
    // This trigger ignored its own payload and re-scanned every connection on
    // the platform, so one org connecting OwnerRez kicked off a platform-wide
    // review sync.
    const supabase = makeSupabase({ integration_connections: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(ownerRezReviewsSync, {
      event: {
        name: 'integration/ownerrez.connected',
        data: { user_id: 'user_9', org_id: 'org_9', external_user_id: 'or_9' },
      },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 1, trigger: 'connected' })
    expect(step.sendEvent).toHaveBeenCalledWith('dispatch-connected-sync', {
      name: 'integration/ownerrez_reviews.connection_requested',
      data: { user_id: 'user_9', org_id: 'org_9' },
    })
    // No platform-wide scan at all.
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('skips a connection with no org_id rather than dispatching an unscoped sync', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [{ user_id: 'user_1', org_id: null }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(ownerRezReviewsSync, {
      event: { name: 'inngest/scheduled.timer' }, step, logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 0, trigger: 'cron' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})
