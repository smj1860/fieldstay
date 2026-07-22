import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/observability/metrics', () => ({
  recordGauge: vi.fn(async () => undefined),
}))

import { metricsSnapshot } from '@/lib/inngest/functions/cron/metrics-snapshot'
import { createServiceClient } from '@/lib/supabase/server'
import { recordGauge } from '@/lib/observability/metrics'
import { invokeHandler } from './test-helpers'

// Simple fixed-per-table mock — this cron issues exactly one query per
// table (no re-querying the same table), so a queue isn't needed here
// unlike the checklist-broadcast/vendor-compliance-grace-check precedents.
function makeSupabase(responses: Record<string, { data?: unknown; error?: unknown }>) {
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = () => chain
    chain.in     = () => chain
    chain.then   = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(responses[table] ?? { data: null, error: null }).then(resolve)
    return chain
  })
  return { from }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

describe('metricsSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records a zero gauge for every tracked status when there is no data', async () => {
    const supabase = makeSupabase({
      work_orders:              { data: [], error: null },
      inventory_items:          { data: [], error: null },
      vendor_compliance_status: { data: [], error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(metricsSnapshot, { event: {}, step: makeStep() })

    expect(result).toEqual({ ranAt: expect.any(String) })

    // 4 open WO statuses + 1 inventory-below-par gauge + 5 compliance statuses = 10
    expect(recordGauge).toHaveBeenCalledTimes(10)
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_work_orders_backlog', 0, { status: 'pending' })
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_inventory_below_par_count', 0)
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_vendor_compliance_status_count', 0, { status: 'compliant' })
  })

  it('tallies real work order, inventory, and compliance rows into the correct gauges', async () => {
    const supabase = makeSupabase({
      work_orders: {
        data: [
          { status: 'pending' }, { status: 'pending' }, { status: 'assigned' },
          { status: 'in_progress' },
        ],
        error: null,
      },
      inventory_items: {
        data: [
          { current_quantity: 2, par_level: 10, first_count_recorded_at: '2026-01-01T00:00:00.000Z' },
          { current_quantity: 20, par_level: 10, first_count_recorded_at: '2026-01-01T00:00:00.000Z' },
        ],
        error: null,
      },
      vendor_compliance_status: {
        data: [
          { compliance_status: 'compliant' }, { compliance_status: 'compliant' },
          { compliance_status: 'hard_blocked' },
        ],
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(metricsSnapshot, { event: {}, step: makeStep() })

    expect(recordGauge).toHaveBeenCalledWith('fieldstay_work_orders_backlog', 2, { status: 'pending' })
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_work_orders_backlog', 1, { status: 'assigned' })
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_work_orders_backlog', 1, { status: 'in_progress' })
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_work_orders_backlog', 0, { status: 'quote_requested' })
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_inventory_below_par_count', 1)
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_vendor_compliance_status_count', 2, { status: 'compliant' })
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_vendor_compliance_status_count', 1, { status: 'hard_blocked' })
  })

  it('excludes never-counted items (first_count_recorded_at null) from the below-par gauge even if quantity is 0', async () => {
    const supabase = makeSupabase({
      work_orders: { data: [], error: null },
      inventory_items: {
        data: [
          // Never counted — current_quantity defaults to 0, which would look
          // "below par" if the first_count_recorded_at guard were missing.
          { current_quantity: 0, par_level: 10, first_count_recorded_at: null },
        ],
        error: null,
      },
      vendor_compliance_status: { data: [], error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(metricsSnapshot, { event: {}, step: makeStep() })

    expect(recordGauge).toHaveBeenCalledWith('fieldstay_inventory_below_par_count', 0)
  })
})
