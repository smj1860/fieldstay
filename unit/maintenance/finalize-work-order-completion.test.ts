import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sendMock = vi.fn()
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...args: unknown[]) => sendMock(...args) } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { finalizeWorkOrderCompletion } from '@/app/(dashboard)/maintenance/complete-work-order-helpers'
import { reportError } from '@/lib/observability/report-error'

// ============================================================================
// finalizeWorkOrderCompletion() used to let inngest.send() throw straight out
// of the function on its first failure — before the work_order_updates insert
// and before advanceSchedulesAfterCompletion ever ran. The completing UPDATE
// that produced `rows` has ALREADY committed by the time this function runs
// (a separate write, not one transaction with it), and every completion call
// site guards its own UPDATE with `.neq('status', 'completed')` — so once the
// row is completed, a thrown error here propagated to the caller's outer
// try/catch as "Operation failed. Please try again." for a work order that
// WAS, in fact, already completed, permanently blocking retry while silently
// losing the event, the audit row, and the schedule advance.
//
// The fix: isolate each side effect so none of them can suppress or lose
// track of the others, and never let the function itself throw.
// ============================================================================

const ROW = {
  id: 'wo_1', property_id: 'p_1', org_id: 'org_1',
  source_schedule_id: null, source: null, actual_cost: 100, estimated_cost: 100,
}

function makeSupabase() {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => { calls.push({ table, method, args }); return chain }
    chain.insert = (...a: unknown[]) => record('insert', a)
    chain.select = (...a: unknown[]) => record('select', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.order  = (...a: unknown[]) => record('order', a)
    chain.range  = async () => ({ data: [], error: null })   // no schedules to advance in these tests
    chain.then   = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
    return chain
  })
  return { from, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('finalizeWorkOrderCompletion', () => {
  it('never throws, even when inngest.send fails on every attempt', async () => {
    sendMock.mockRejectedValue(new Error('inngest unreachable'))
    const supabase = makeSupabase()

    const promise = finalizeWorkOrderCompletion(supabase as never, 'org_1', [ROW])
    // Let the internal retry backoff (fake timers) run to completion.
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toBeUndefined()
  })

  it('still writes the work_order_updates audit row when inngest.send fails', async () => {
    sendMock.mockRejectedValue(new Error('inngest unreachable'))
    const supabase = makeSupabase()

    const promise = finalizeWorkOrderCompletion(supabase as never, 'org_1', [ROW])
    await vi.runAllTimersAsync()
    await promise

    expect(supabase.calls.some((c) => c.table === 'work_order_updates' && c.method === 'insert')).toBe(true)
  })

  it('reports the failure to Sentry after exhausting retries, rather than swallowing it silently', async () => {
    sendMock.mockRejectedValue(new Error('inngest unreachable'))
    const supabase = makeSupabase()

    const promise = finalizeWorkOrderCompletion(supabase as never, 'org_1', [ROW])
    await vi.runAllTimersAsync()
    await promise

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'maintenance.finalizeWorkOrderCompletion.send' }),
    )
  })

  it('retries a transient send failure and succeeds without ever reporting an error', async () => {
    sendMock
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined)
    const supabase = makeSupabase()

    const promise = finalizeWorkOrderCompletion(supabase as never, 'org_1', [ROW])
    await vi.runAllTimersAsync()
    await promise

    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('succeeds cleanly with no retries needed when inngest.send works the first time', async () => {
    sendMock.mockResolvedValue(undefined)
    const supabase = makeSupabase()

    await finalizeWorkOrderCompletion(supabase as never, 'org_1', [ROW])

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(reportError).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.table === 'work_order_updates' && c.method === 'insert')).toBe(true)
  })

  it('is a no-op for an empty row set — no send, no writes', async () => {
    const supabase = makeSupabase()
    await finalizeWorkOrderCompletion(supabase as never, 'org_1', [])

    expect(sendMock).not.toHaveBeenCalled()
    expect(supabase.calls).toEqual([])
  })
})
