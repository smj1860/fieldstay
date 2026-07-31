import { readFileSync } from 'node:fs'
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
import { createSupabaseDouble, type QueryResponse } from '../stubs/supabase-query-double'

// This cron no longer selects whole tables and tallies them in JS — a
// platform-wide `.select()` was silently capped at PostgREST's 1000-row limit,
// so the gauges flat-lined at the cap instead of reporting the real backlog
// (inventory_items alone is ~500k rows at 150 tenants). Every gauge is now
// fed by a SQL aggregate RPC
// (supabase/migrations/20260730400000_scalability_aggregate_rpcs.sql), so the
// double stubs `supabase.rpc(name)` per function name rather than `.from()`.
function makeSupabase(rpcResults: Record<string, QueryResponse>) {
  return createSupabaseDouble({}, {
    rpc: (fn: string) => rpcResults[fn] ?? { data: null, error: null },
  })
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
      metrics_work_order_backlog:         { data: [], error: null },
      metrics_inventory_below_par_count:  { data: 0, error: null },
      metrics_vendor_compliance_counts:   { data: [], error: null },
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

  it('tallies the work order, inventory, and compliance aggregates into the correct gauges', async () => {
    const supabase = makeSupabase({
      metrics_work_order_backlog: {
        data: [
          { status: 'pending', count: 2 },
          { status: 'assigned', count: 1 },
          { status: 'in_progress', count: 1 },
        ],
        error: null,
      },
      metrics_inventory_below_par_count: { data: 1, error: null },
      metrics_vendor_compliance_counts: {
        data: [
          { compliance_status: 'compliant', count: 2 },
          { compliance_status: 'hard_blocked', count: 1 },
        ],
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(metricsSnapshot, { event: {}, step: makeStep() })

    expect(recordGauge).toHaveBeenCalledWith('fieldstay_work_orders_backlog', 2, { status: 'pending' })
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_work_orders_backlog', 1, { status: 'assigned' })
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_work_orders_backlog', 1, { status: 'in_progress' })
    // A status the aggregate returned no row for still reports an explicit 0.
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_work_orders_backlog', 0, { status: 'quote_requested' })
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_inventory_below_par_count', 1)
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_vendor_compliance_status_count', 2, { status: 'compliant' })
    expect(recordGauge).toHaveBeenCalledWith('fieldstay_vendor_compliance_status_count', 1, { status: 'hard_blocked' })
    // No table is scanned any more — every gauge comes from a SQL aggregate.
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('throws instead of reporting a silently wrong gauge when an aggregate RPC errors', async () => {
    const supabase = makeSupabase({
      metrics_work_order_backlog: { data: null, error: { message: 'relation missing' } },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(metricsSnapshot, { event: {}, step: makeStep() }),
    ).rejects.toThrow('metrics_work_order_backlog failed: relation missing')
  })

  it('excludes never-counted items (first_count_recorded_at null) from the below-par gauge', () => {
    // This exclusion used to be a JS-side filter in this cron and is now part
    // of metrics_inventory_below_par_count()'s SQL body — items never counted
    // default current_quantity to 0, which would look "below par" on every
    // freshly-added item. Asserted where the logic actually lives now.
    const sql = readFileSync(
      new URL('../../supabase/migrations/20260730400000_scalability_aggregate_rpcs.sql', import.meta.url),
      'utf8',
    )
    const body = sql.slice(
      sql.indexOf('FUNCTION public.metrics_inventory_below_par_count'),
      sql.indexOf('COMMENT ON FUNCTION public.metrics_inventory_below_par_count'),
    )
    expect(body).toContain('i.first_count_recorded_at IS NOT NULL')
    expect(body).toContain('COALESCE(i.current_quantity, 0) < COALESCE(i.par_level, 1)')
  })
})
