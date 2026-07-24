import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable-token', () => ({
  getValidHospitableToken: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable', () => ({
  hospFetchReviews: vi.fn(),
}))

import { hospReviewsBackfill } from '@/lib/inngest/functions/hospitable/hospitable-reviews-backfill'
import { createServiceClient } from '@/lib/supabase/server'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { hospFetchReviews } from '@/lib/integrations/providers/hospitable'
// Real (unmocked) — pure error classification, same as the OwnerRez precedent tests.
import { RateLimitError } from '@/lib/integrations/types'
import { invokeHandler } from './test-helpers'

function runAllStep() {
  return {
    run:   vi.fn((_name: string, cb: () => unknown) => cb()),
    sleep: vi.fn(async () => undefined),
  }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() }
}

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

function makeSupabase(queued: QueuedByTable) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.not    = (...a: unknown[]) => record('not', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

const EVENT_DATA = { user_id: 'user_1', org_id: 'org_1', external_user_id: 'ext_1' }

const RAW_REVIEW = {
  id:          'rev_1',
  platform:    'airbnb' as const,
  reviewed_at: '2026-07-01',
  guest:       { first_name: 'Jane', last_name: 'Guest' },
  public:      { rating: 5, review: 'Great stay' },
}

describe('hospReviewsBackfill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getValidHospitableToken as ReturnType<typeof vi.fn>).mockResolvedValue('token_abc')
  })

  it('fetches reviews per synced property, upserts on the idempotent conflict target, and records success on the connection', async () => {
    ;(hospFetchReviews as ReturnType<typeof vi.fn>).mockResolvedValue([RAW_REVIEW])
    const supabase = makeSupabase({
      properties: [{ data: [{ id: 'prop_1', external_id: 'hosp_prop_1' }], error: null }],
      reviews:    [{ error: null }], // upsert
      integration_connections: [
        { data: { metadata: {} }, error: null }, // updateConnectionMeta: read
        { error: null },                          // updateConnectionMeta: write
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospReviewsBackfill, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ reviews: 1 })
    expect(hospFetchReviews).toHaveBeenCalledWith('token_abc', 'hosp_prop_1')

    const upsert = supabase.calls.find((c) => c.table === 'reviews' && c.method === 'upsert')
    expect(upsert?.args[1]).toEqual({ onConflict: 'org_id,external_id,external_source', ignoreDuplicates: false })
    expect(upsert?.args[0]).toEqual([{
      org_id: 'org_1', external_id: 'rev_1', external_source: 'hospitable', external_url: null,
      property_id: 'prop_1', guest_name: 'Jane Guest', rating: 5, review_text: 'Great stay',
      review_date: '2026-07-01', response_status: 'pending',
    }])

    const metaUpdate = supabase.calls.find(
      (c) => c.table === 'integration_connections' && c.method === 'update',
    )
    const metadata = (metaUpdate?.args[0] as { metadata: Record<string, unknown> }).metadata
    expect(metadata).toMatchObject({
      last_reviews_backfill_status: 'success',
      last_reviews_backfill_error:  null,
      last_reviews_backfill_count:  1,
    })
  })

  it('skips entirely when the org has no synced Hospitable properties yet', async () => {
    const supabase = makeSupabase({
      properties: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospReviewsBackfill, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ reviews: 0 })
    expect(getValidHospitableToken).not.toHaveBeenCalled()
    expect(hospFetchReviews).not.toHaveBeenCalled()
  })

  it('skips the upsert call entirely when every synced property has zero reviews, rather than issuing an empty write', async () => {
    ;(hospFetchReviews as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const supabase = makeSupabase({
      properties: [{ data: [{ id: 'prop_1', external_id: 'hosp_prop_1' }], error: null }],
      integration_connections: [
        { data: { metadata: {} }, error: null },
        { error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospReviewsBackfill, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ reviews: 0 })
    expect(supabase.calls.some((c) => c.table === 'reviews')).toBe(false)
  })

  it('sleeps and retries once on a rate limit before giving up, rather than treating the first 429 as a hard failure', async () => {
    ;(hospFetchReviews as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new RateLimitError(30))
      .mockResolvedValueOnce([RAW_REVIEW])
    const supabase = makeSupabase({
      properties: [{ data: [{ id: 'prop_1', external_id: 'hosp_prop_1' }], error: null }],
      reviews:    [{ error: null }],
      integration_connections: [
        { data: { metadata: {} }, error: null },
        { error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const result = await invokeHandler(hospReviewsBackfill, {
      event: { data: EVENT_DATA },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ reviews: 1 })
    expect(step.sleep).toHaveBeenCalledWith('rate-limit-sleep-prop_1', '30s')
    expect(hospFetchReviews).toHaveBeenCalledTimes(2)
  })

  it('records a translated error on the connection and rethrows when the reviews fetch fails for a non-rate-limit reason', async () => {
    ;(hospFetchReviews as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('401 unauthorized'))
    const supabase = makeSupabase({
      properties: [{ data: [{ id: 'prop_1', external_id: 'hosp_prop_1' }], error: null }],
      integration_connections: [
        { data: { metadata: {} }, error: null }, // record-backfill-error: read
        { error: null },                          // record-backfill-error: write
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(invokeHandler(hospReviewsBackfill, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })).rejects.toThrow('401 unauthorized')

    const metaUpdate = supabase.calls.find(
      (c) => c.table === 'integration_connections' && c.method === 'update',
    )
    const metadata = (metaUpdate?.args[0] as { metadata: Record<string, unknown> }).metadata
    expect(metadata.last_reviews_backfill_status).toBe('error')
    expect(metadata.last_reviews_backfill_error).toBe('Hospitable authorization expired — reconnect your account to resume syncing')
  })
})
