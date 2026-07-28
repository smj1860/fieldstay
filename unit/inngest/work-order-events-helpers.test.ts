import { describe, it, expect, vi } from 'vitest'
import { NonRetriableError } from 'inngest'
import { loadDispatchContext } from '@/lib/inngest/functions/work-order-events-helpers'

// FINDING-2: confirmed live 2026-07-25 — dozens of distinct work order ids,
// all "Work order {id} query failed: Cannot coerce the result to a single
// JSON object (code: PGRST116)" from this exact query (.single() on
// work_orders filtered only by id, a primary key — so PGRST116 here can
// only ever be the zero-row case, never the multi-row case: verified
// empirically that none of the sampled ids exist in work_orders,
// work_order_updates, or audit_events at all). Root cause: the work order
// was deleted (most likely by the org-level cascade in FINDING-1) between
// the work-order/created event firing and this step running. These tests
// prove the zero-row case now throws a clear NonRetriableError instead of
// PostgREST's generic PGRST116 message, while a genuine query error still
// throws (and still retries).

function makeSupabase(result: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn(() => chain),
    eq:     vi.fn(() => chain),
    maybeSingle: vi.fn(async () => result),
  }
  return { from: vi.fn(() => chain) }
}

describe('loadDispatchContext', () => {
  it('throws a clear NonRetriableError when the work order no longer exists (zero rows)', async () => {
    const supabase = makeSupabase({ data: null, error: null })

    await expect(
      loadDispatchContext(supabase as never, 'wo_deleted', 'org_1'),
    ).rejects.toThrow(NonRetriableError)
    await expect(
      loadDispatchContext(supabase as never, 'wo_deleted', 'org_1'),
    ).rejects.toThrow('Work order wo_deleted no longer exists — skipping vendor dispatch')
  })

  it('still throws a retriable Error (not NonRetriableError) on a genuine query failure', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'connection reset', code: '08006' } })

    const rejection = expect(
      loadDispatchContext(supabase as never, 'wo_1', 'org_1'),
    ).rejects

    await rejection.toThrow('Work order wo_1 query failed: connection reset (code: 08006)')
    await rejection.not.toBeInstanceOf(NonRetriableError)
  })
})
