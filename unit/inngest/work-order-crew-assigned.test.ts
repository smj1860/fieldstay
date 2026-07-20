import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { handleWorkOrderCrewAssigned } from '@/lib/inngest/functions/work-order-crew-assigned'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

function makeSupabase(result: { data?: unknown; error?: unknown }) {
  const eq = vi.fn()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  chain.select = vi.fn(() => chain)
  chain.eq     = eq
  chain.single = vi.fn(() => Promise.resolve(result))
  eq.mockReturnValue(chain)
  const from = vi.fn(() => chain)
  return { from, eq }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

// This handler is currently a scaffold for a future push-notification
// integration — it only logs the assignment via a WO lookup and always
// returns the same "not yet notified" result (push sends are pending
// 10DLC verification, per SMS_ENABLED gating elsewhere in the codebase).
// There's no branch on whether the WO lookup succeeds, so both cases below
// are expected to converge on the same return value.
describe('handleWorkOrderCrewAssigned', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('looks up the work order for logging and returns the scaffolded not-yet-notified result', async () => {
    const supabase = makeSupabase({ data: { wo_number: 'WO-77', title: 'Fix Deck' }, error: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleWorkOrderCrewAssigned, {
      event: { data: { workOrderId: 'wo_1', orgId: 'org_1', crewMemberId: 'crew_1' } },
      step:  runAllStep(),
    })

    expect(supabase.from).toHaveBeenCalledWith('work_orders')
    expect(supabase.eq).toHaveBeenCalledWith('id', 'wo_1')
    expect(supabase.eq).toHaveBeenCalledWith('org_id', 'org_1')
    expect(result).toEqual({ notified: false, reason: 'push_notifications_pending_10dlc' })
  })

  it('returns the same scaffolded result even when the work order lookup finds nothing', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleWorkOrderCrewAssigned, {
      event: { data: { workOrderId: 'wo_missing', orgId: 'org_1', crewMemberId: 'crew_1' } },
      step:  runAllStep(),
    })

    expect(result).toEqual({ notified: false, reason: 'push_notifications_pending_10dlc' })
  })
})
