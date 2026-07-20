import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { handleTurnoverCompleted } from '@/lib/inngest/functions/turnover-events'
import { handleWorkOrderCompleted } from '@/lib/inngest/functions/work-order-events'
import { handlePurchaseOrderApproved } from '@/lib/inngest/functions/inventory-events'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// These three Inngest functions each post exactly one owner_transactions
// row via `.upsert(..., { onConflict: 'source_reference_id,source',
// ignoreDuplicates: true })` — that conflict target + flag combination IS
// the idempotency guarantee (a webhook/event redelivery hits the same
// source_reference_id and Postgres silently no-ops the second insert).
// A step-allowlist stub for `step.run` executes only the named financial
// step under test and no-ops every other step in the function, so these
// tests exercise the real upsert call without mocking every notification/
// email/metrics dependency the rest of each function pulls in.
function makeAllowlistStep(allowed: string) {
  return {
    run: vi.fn((name: string, cb: () => unknown) => (name === allowed ? cb() : Promise.resolve(undefined))),
    sleep:     vi.fn(),
    sendEvent: vi.fn(),
  }
}

function makeSupabase(perTable: Record<string, { data?: unknown; error?: unknown }>) {
  const upsertSpy = vi.fn()
  const from = vi.fn((table: string) => {
    const result = perTable[table] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.upsert = vi.fn((payload: unknown, opts: unknown) => {
      upsertSpy(table, payload, opts)
      return chain
    })
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, upsertSpy }
}

const IDEMPOTENT_UPSERT_OPTS = { onConflict: 'source_reference_id,source', ignoreDuplicates: true }

describe('financial ledger posting — idempotent upsert shape', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('turnover-completed posts a cleaning-fee expense keyed on the turnover id', async () => {
    const supabase = makeSupabase({
      properties: { data: { cleaning_cost: 150, same_day_premium_pct: null }, error: null },
      turnovers:  { data: { is_same_day_turnover: false }, error: null },
      owner_transactions: { data: { id: 'txn_1' }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleTurnoverCompleted, {
      event: { data: { turnover_id: 'to_1', property_id: 'prop_1', org_id: 'org_1' } },
      step:  makeAllowlistStep('post-cleaning-fee-expense'),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'owner_transactions',
      expect.objectContaining({ source: 'cleaning_fee', source_reference_id: 'to_1' }),
      IDEMPOTENT_UPSERT_OPTS,
    )
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
  })

  it('work-order-completed posts a maintenance expense keyed on the work order id', async () => {
    const supabase = makeSupabase({
      work_orders: { data: { title: 'Fix sink', actual_cost: 300 }, error: null },
      owner_transactions: { data: { id: 'txn_2' }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderCompleted, {
      event: { data: { work_order_id: 'wo_1', property_id: 'prop_1', org_id: 'org_1' } },
      step:  makeAllowlistStep('post-wo-expense'),
    })

    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'owner_transactions',
      expect.objectContaining({ source: 'wo_completion', source_reference_id: 'wo_1', amount: 300 }),
      IDEMPOTENT_UPSERT_OPTS,
    )
  })

  it('work-order-completed skips posting when actual_cost is not yet known', async () => {
    const supabase = makeSupabase({
      work_orders: { data: { title: 'Fix sink', actual_cost: null }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderCompleted, {
      event: { data: { work_order_id: 'wo_2', property_id: 'prop_1', org_id: 'org_1' } },
      step:  makeAllowlistStep('post-wo-expense'),
    })

    expect(supabase.upsertSpy).not.toHaveBeenCalled()
  })

  it('purchase-order-approved posts a restock expense keyed on the purchase order id', async () => {
    const supabase = makeSupabase({
      owner_transactions: { data: { id: 'txn_3' }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handlePurchaseOrderApproved, {
      event: {
        data: {
          purchase_order_id: 'po_1', property_id: 'prop_1', org_id: 'org_1', total_estimated_cost: 87.5,
        },
      },
      step: makeAllowlistStep('post-inventory-expense'),
    })

    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'owner_transactions',
      expect.objectContaining({ source: 'inventory_purchase', source_reference_id: 'po_1', amount: 87.5 }),
      IDEMPOTENT_UPSERT_OPTS,
    )
  })
})
