import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((_opts: unknown, _trigger: unknown, fn: unknown) => ({ fn })),
    send:           vi.fn(async () => undefined),
  },
}))
vi.mock('@/lib/resend/client', () => ({ resend: { emails: { send: vi.fn(async () => ({})) } }, FROM: 'x@y.z' }))
vi.mock('@/lib/inngest/helpers', () => ({ getPmEmails: vi.fn(async () => []) }))
vi.mock('@/lib/resend/emails/pm-alert', () => ({ renderPmAlert: vi.fn(() => '<p/>') }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/inngest/paginate', () => ({
  fetchAllRows: vi.fn(async () => []),
  SUPABASE_MAX_ROWS: 1000,
}))

import { handleInventoryCountSubmitted } from '@/lib/inngest/functions/inventory-events'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

/**
 * Replaces the mechanical coverage the inngest-insert-idempotency guardrail
 * lost when the purchase_order_items insert moved into a helper (that scan
 * only inspects `.insert(` inside a step.run body). See the removal note in
 * unit/guardrails/inngest-insert-idempotency.test.ts.
 *
 * The defect being pinned: the PO existence pre-check used to short-circuit on
 * the HEADER row alone. If the items insert failed after the header committed,
 * every retry found the header, returned alreadyExisted, and the PM opened a
 * restock order listing nothing — permanently, with nothing logged, because
 * both writes discarded their results.
 */
function makeSupabase(opts: {
  existingPo?:   { id: string; purchase_order_items: { id: string }[] } | null
  existingError?: { message: string } | null
  itemsInsertError?: { message: string } | null
  updateError?:  { message: string } | null
}) {
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'range', 'lt', 'gt']) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }
    chain.insert = (...a: unknown[]) => {
      record('insert', a)
      if (table === 'purchase_order_items') {
        return Promise.resolve({ data: null, error: opts.itemsInsertError ?? null })
      }
      return chain
    }
    chain.update = (...a: unknown[]) => {
      record('update', a)
      if (table === 'purchase_orders') {
        // The `.eq('id', …)` that follows resolves this thenable.
        chain.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: opts.updateError ?? null }).then(res)
      }
      return chain
    }
    chain.single = () => Promise.resolve({ data: { id: 'po_new' }, error: null })
    chain.maybeSingle = () =>
      Promise.resolve({ data: opts.existingPo ?? null, error: opts.existingError ?? null })
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(res, rej)
    return chain
  })

  return { from, calls }
}

const event = {
  data: { count_id: 'cnt_1', property_id: 'prop_1', org_id: 'org_1' },
}

// The handler bails before the PO block unless there are below-par items, so
// these tests drive it through a step stub that supplies them.
function makeStep(belowPar: unknown[]) {
  return {
    // Keyed on step NAME rather than call order: the count-application step is
    // stubbed out (it is not what these tests pin), and every later step —
    // create-purchase-order included — runs its real body.
    run: vi.fn(async (name: string, cb: () => unknown) => {
      if (name === 'apply-count-and-check-par') return { belowParItems: belowPar }
      return cb()
    }),
  }
}

const belowParItem = {
  id: 'item_1', name: 'Paper towels', current_quantity: 1,
  par_level: 6, quantity_to_buy: 5, unit: 'roll',
}

describe('handleInventoryCountSubmitted — purchase order creation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does NOT short-circuit on a purchase order header that has zero line items', async () => {
    const supabase = makeSupabase({
      existingPo: { id: 'po_orphan', purchase_order_items: [] },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleInventoryCountSubmitted, {
      event, step: makeStep([belowParItem]),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }).catch(() => { /* later email steps are not under test */ })

    // The repair path must actually write the missing items.
    const itemsInsert = supabase.calls.find(
      (c) => c.table === 'purchase_order_items' && c.method === 'insert',
    )
    expect(itemsInsert).toBeDefined()
    const rows = itemsInsert!.args[0] as { purchase_order_id: string }[]
    expect(rows[0]!.purchase_order_id).toBe('po_orphan')
  })

  it('short-circuits on a purchase order that already has line items', async () => {
    const supabase = makeSupabase({
      existingPo: { id: 'po_done', purchase_order_items: [{ id: 'poi_1' }] },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleInventoryCountSubmitted, {
      event, step: makeStep([belowParItem]),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }).catch(() => { /* later steps not under test */ })

    expect(
      supabase.calls.some((c) => c.table === 'purchase_order_items' && c.method === 'insert'),
      'a complete PO must not have its items re-inserted on a retry',
    ).toBe(false)
  })

  it('throws when the line-item insert fails, instead of reporting success', async () => {
    const supabase = makeSupabase({
      existingPo: null,
      itemsInsertError: { message: 'deadlock detected' },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(handleInventoryCountSubmitted, {
        event, step: makeStep([belowParItem]),
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(/purchase_order_items insert failed/)
  })

  it('throws when the PO existence pre-check errors, rather than creating a second PO', async () => {
    const supabase = makeSupabase({
      existingPo: null,
      existingError: { message: 'connection reset' },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(handleInventoryCountSubmitted, {
        event, step: makeStep([belowParItem]),
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(/pre-check failed/)
  })
})
