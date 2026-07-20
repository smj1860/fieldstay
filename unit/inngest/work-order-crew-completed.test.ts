import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(),
}))
vi.mock('@/lib/observability/metrics', () => ({
  incrementCounter: vi.fn(),
}))

import { handleWorkOrderCrewCompleted } from '@/lib/inngest/functions/work-order-crew-completed'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { incrementCounter } from '@/lib/observability/metrics'
import { invokeHandler } from './test-helpers'

// Fixed canned response per table — every table here is queried exactly
// once per test (work_orders + crew_members in a Promise.all, then
// properties), so no call-ordering is needed.
function makeSupabase(perTable: Record<string, { data?: unknown; error?: unknown }>) {
  const from = vi.fn((table: string) => {
    const result = perTable[table] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.single = vi.fn(() => Promise.resolve(result))
    return chain
  })
  return { from }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

describe('handleWorkOrderCrewCompleted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits the completion metric and notifies the PM with the crew/WO/property names', async () => {
    const supabase = makeSupabase({
      work_orders:  { data: { id: 'wo_1', wo_number: 'WO-42', title: 'Fix the sink', property_id: 'prop_1' }, error: null },
      crew_members: { data: { id: 'c1', name: 'Maria' }, error: null },
      properties:   { data: { name: 'The Lakehouse', address: '1 Lake Dr' }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleWorkOrderCrewCompleted, {
      event: {
        data: {
          workOrderId:  'wo_1',
          orgId:        'org_1',
          crewMemberId: 'c1',
          completedAt:  '2026-07-20T10:00:00Z',
          notes:        'All done, no issues',
        },
      },
      step: runAllStep(),
    })

    expect(incrementCounter).toHaveBeenCalledWith(
      'fieldstay_work_orders_completed_by_crew_total',
      { org_id: 'org_1' },
    )
    expect(createPmNotification).toHaveBeenCalledWith(supabase, {
      orgId:     'org_1',
      type:      'work_order_complete',
      title:     '✓ Work Complete — WO-42 · The Lakehouse',
      subtitle:  'Maria marked "Fix the sink" complete — All done, no issues',
      href:      '/maintenance/wo_1',
      severity:  'green',
      dedupeKey: 'crew-wo-complete-wo_1',
    })
    expect(result).toEqual({ notified: true })
  })

  it('falls back to generic labels when the WO, crew, and property lookups all return nothing', async () => {
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderCrewCompleted, {
      event: {
        data: {
          workOrderId:  'wo_2',
          orgId:        'org_1',
          crewMemberId: 'c2',
          completedAt:  '2026-07-20T10:00:00Z',
          notes:        null,
        },
      },
      step: runAllStep(),
    })

    expect(createPmNotification).toHaveBeenCalledWith(supabase, expect.objectContaining({
      title:    '✓ Work Complete — WO · the property',
      subtitle: 'A crew member marked "a work order" complete',
    }))
  })
})
