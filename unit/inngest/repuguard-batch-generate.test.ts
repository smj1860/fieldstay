import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/repuguard/generate-response', () => ({
  generateReviewResponse: vi.fn(),
}))

import { repuguardBatchGenerate } from '@/lib/inngest/functions/repuguard-batch-generate'
import { createServiceClient } from '@/lib/supabase/server'
import { generateReviewResponse } from '@/lib/repuguard/generate-response'
import { invokeHandler } from './test-helpers'

// Queue-based mock: each `.from(table)` call consumes the next queued
// response for that table, in call order — mirrors checklist-broadcast.test.ts.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    for (const method of ['select', 'eq', 'order', 'limit', 'update', 'upsert']) {
      chain[method] = (...a: unknown[]) => record(method, a)
    }

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.then = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return {
    run:   vi.fn((_name: string, cb: () => unknown) => cb()),
    sleep: vi.fn(async () => undefined),
  }
}

const defaultLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function batchEvent(overrides: Partial<{ org_id: string; requested_by: string }> = {}) {
  return { data: { org_id: 'org_1', requested_by: 'user_1', ...overrides } }
}

function review(overrides: Partial<{
  id: string; review_text: string; rating: number; guest_name: string | null
  internal_notes: string | null; properties: unknown
}> = {}) {
  return {
    id:              'rev_1',
    review_text:     'Great stay, loved the view.',
    rating:           5,
    guest_name:      'Alex',
    internal_notes:  null,
    properties:      { name: 'Sunset Villa' },
    ...overrides,
  }
}

const cleanResponse = {
  response:    'Thank you so much for staying with us!',
  word_count:   120,
  tone_used:    'warm, appreciative',
  flags:        [] as string[],
  flag_reason:  null,
}

describe('repuguardBatchGenerate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a no-op when there are no pending reviews', async () => {
    const supabase = makeSupabase({
      reviews: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(repuguardBatchGenerate, {
      event:  batchEvent(),
      step:   makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ generated: 0, skipped: 0 })
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(generateReviewResponse).not.toHaveBeenCalled()
  })

  it('throws when the pending-reviews fetch itself errors', async () => {
    const supabase = makeSupabase({
      reviews: [{ data: null, error: { message: 'connection reset' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(repuguardBatchGenerate, {
        event:  batchEvent(),
        step:   makeStep(),
        logger: defaultLogger,
      }),
    ).rejects.toThrow('Failed to fetch pending reviews: connection reset')
  })

  it('generates drafts for every pending review, pacing between them but not after the last', async () => {
    const reviews = [
      review({ id: 'rev_1', properties: { name: 'Sunset Villa' } }),
      review({ id: 'rev_2', properties: [{ name: 'Lakeview Cabin' }], guest_name: null }),
    ]
    const supabase = makeSupabase({
      reviews: [
        { data: reviews, error: null },
        { data: null, error: null }, // update after rev_1
        { data: null, error: null }, // update after rev_2
      ],
      review_responses: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(generateReviewResponse as ReturnType<typeof vi.fn>).mockResolvedValue(cleanResponse)

    const step = makeStep()
    const result = await invokeHandler(repuguardBatchGenerate, {
      event:  batchEvent(),
      step,
      logger: defaultLogger,
    })

    expect(result).toEqual({ generated: 2, skipped: 0 })
    expect(generateReviewResponse).toHaveBeenNthCalledWith(1, {
      reviewText:     'Great stay, loved the view.',
      starRating:      5,
      propertyName:   'Sunset Villa',
      guestName:      'Alex',
      internalNotes:   null,
    })
    // Array-shaped join unwraps to its first element; null guest_name falls back to 'Guest'.
    expect(generateReviewResponse).toHaveBeenNthCalledWith(2, expect.objectContaining({
      propertyName: 'Lakeview Cabin',
      guestName:    'Guest',
    }))

    const upserts = supabase.calls.filter((c) => c.table === 'review_responses' && c.method === 'upsert')
    expect(upserts).toHaveLength(2)
    expect(upserts[0].args[0]).toEqual(expect.objectContaining({
      review_id:          'rev_1',
      org_id:             'org_1',
      generated_response: cleanResponse.response,
      edited_response:    null,
      word_count:         120,
      tone_used:          'warm, appreciative',
      flags:              [],
      flag_reason:        null,
    }))
    expect(upserts[0].args[1]).toEqual({ onConflict: 'review_id' })

    const reviewUpdates = supabase.calls.filter((c) => c.table === 'reviews' && c.method === 'update')
    expect(reviewUpdates).toHaveLength(2)
    expect(reviewUpdates[0].args[0]).toEqual(expect.objectContaining({ response_status: 'ready' }))

    // Paced once between the two reviews, never after the last one.
    expect(step.sleep).toHaveBeenCalledTimes(1)
    expect(step.sleep).toHaveBeenCalledWith('pace-rev_1', '500ms')
  })

  it('marks a flagged review as draft instead of ready', async () => {
    const supabase = makeSupabase({
      reviews: [
        { data: [review()], error: null },
        { data: null, error: null },
      ],
      review_responses: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(generateReviewResponse as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...cleanResponse,
      flags:       ['legal'],
      flag_reason: 'Guest mentions contacting a lawyer',
    })

    const result = await invokeHandler(repuguardBatchGenerate, {
      event:  batchEvent(),
      step:   makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ generated: 1, skipped: 0 })
    const reviewUpdate = supabase.calls.find((c) => c.table === 'reviews' && c.method === 'update')
    expect(reviewUpdate?.args[0]).toEqual(expect.objectContaining({ response_status: 'draft' }))
  })

  it('counts a permanent generation failure as skipped without writing a draft', async () => {
    const supabase = makeSupabase({
      reviews: [{ data: [review()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(generateReviewResponse as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Malformed response: missing required field'),
    )

    const result = await invokeHandler(repuguardBatchGenerate, {
      event:  batchEvent(),
      step:   makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ generated: 0, skipped: 1 })
    expect(defaultLogger.error).toHaveBeenCalledWith(expect.stringContaining('permanent failure'))
    expect(supabase.calls.some((c) => c.table === 'review_responses')).toBe(false)
  })

  it('re-throws a transient generation failure so Inngest retries that review', async () => {
    const supabase = makeSupabase({
      reviews: [{ data: [review()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(generateReviewResponse as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('rate limit exceeded, please retry'),
    )

    await expect(
      invokeHandler(repuguardBatchGenerate, {
        event:  batchEvent(),
        step:   makeStep(),
        logger: defaultLogger,
      }),
    ).rejects.toThrow('rate limit exceeded')

    expect(defaultLogger.warn).toHaveBeenCalledWith(expect.stringContaining('transient failure'))
  })
})
