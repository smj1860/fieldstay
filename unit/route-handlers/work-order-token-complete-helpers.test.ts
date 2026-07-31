import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))

import {
  createVendorInvoice,
  rollbackVendorInvoice,
  rollbackUnclaimedInvoice,
  insertVendorLineItems,
  logVendorInvoiceCreated,
  finalizeVendorCompletion,
  type SafeLineItem,
} from '@/app/api/work-orders/[token]/complete/helpers'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'

type Resp = { data?: unknown; error?: unknown }

/**
 * Minimal Supabase double: one queued result per `.from(table)` call, plus an
 * ordered log of every builder method so a test can assert what ran and in
 * which order.
 */
function makeSupabase(queue: Record<string, Resp[]>, rpc: Resp = { data: 1, error: null }) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'in']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls, rpc: vi.fn(async () => rpc) }
}

const TARGET = { id: 'wo_1', org_id: 'org_1', vendor_id: 'vendor_1', property_id: 'prop_1' }
const CLAIMED = { ...TARGET, wo_number: 'WO-1', source_turnover_id: null }

const LINE_ITEMS: SafeLineItem[] = [
  { line_type: 'labor', description: '  Fix sink  ', quantity: 2, unit_cost: 75.005, line_total: 150 },
]

describe('createVendorInvoice', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports the invoice it inserted as this request\'s own, so it can be rolled back', async () => {
    const supabase = makeSupabase({ work_order_invoices: [{ data: { id: 'inv_1' }, error: null }] })

    const result = await createVendorInvoice(supabase as never, TARGET, LINE_ITEMS, 150)

    expect(result).toEqual({
      ok: true, invoiceId: 'inv_1', invoiceNumber: 'INV-' + new Date().getFullYear() + '-00001',
      insertedByThisRequest: true,
    })
  })

  it('returns an already-existing invoice WITHOUT claiming it as this request\'s own', async () => {
    // Upsert conflicted (ignoreDuplicates inserted nothing), fallback select
    // finds the row an earlier attempt created.
    const supabase = makeSupabase({
      work_order_invoices: [
        { data: null, error: null },
        { data: { id: 'inv_existing' }, error: null },
      ],
    })

    const result = await createVendorInvoice(supabase as never, TARGET, LINE_ITEMS, 150)

    expect(result).toEqual({
      ok: true, invoiceId: 'inv_existing', invoiceNumber: null, insertedByThisRequest: false,
    })
  })

  it('writes no invoice at all when no line items were submitted', async () => {
    const supabase = makeSupabase({})

    const result = await createVendorInvoice(supabase as never, TARGET, [], 0)

    expect(result).toEqual({ ok: true, invoiceId: null, invoiceNumber: null, insertedByThisRequest: false })
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('writes no invoice when the work order has no vendor to bill', async () => {
    const supabase = makeSupabase({})

    const result = await createVendorInvoice(
      supabase as never, { ...TARGET, vendor_id: null }, LINE_ITEMS, 150,
    )

    expect(result).toEqual({ ok: true, invoiceId: null, invoiceNumber: null, insertedByThisRequest: false })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('fails closed when invoice numbering errors, rather than inserting an unnumbered invoice', async () => {
    const supabase = makeSupabase({}, { data: null, error: { message: 'sequence gone' } })

    const result = await createVendorInvoice(supabase as never, TARGET, LINE_ITEMS, 150)

    expect(result.ok).toBe(false)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('does not write the audit event — that is deferred until the claim is won', async () => {
    const supabase = makeSupabase({ work_order_invoices: [{ data: { id: 'inv_1' }, error: null }] })

    await createVendorInvoice(supabase as never, TARGET, LINE_ITEMS, 150)

    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})

describe('rollbackVendorInvoice', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes exactly the one invoice id it is given', async () => {
    const supabase = makeSupabase({ work_order_invoices: [{ data: null, error: null }] })

    await rollbackVendorInvoice(supabase as never, 'inv_1')

    expect(supabase.calls).toEqual([
      { table: 'work_order_invoices', method: 'delete', args: [] },
      { table: 'work_order_invoices', method: 'eq',     args: ['id', 'inv_1'] },
    ])
  })
})

describe('insertVendorLineItems', () => {
  beforeEach(() => vi.clearAllMocks())

  it('inserts trimmed, org-scoped, vendor-flagged rows with a recomputed line total', async () => {
    const supabase = makeSupabase({ work_order_line_items: [{ data: null, error: null }] })

    await insertVendorLineItems(supabase as never, CLAIMED, LINE_ITEMS)

    const insert = supabase.calls.find((c) => c.method === 'insert')
    expect(insert?.args[0]).toEqual([{
      work_order_id:    'wo_1',
      org_id:           'org_1',
      line_type:        'labor',
      description:      'Fix sink',
      quantity:         2,
      unit_cost:        75.005,
      // Recomputed server-side rather than trusting the submitted line_total.
      line_total:       150.01,
      sort_order:       0,
      vendor_submitted: true,
    }])
  })

  it('touches nothing when there are no line items', async () => {
    const supabase = makeSupabase({})

    await insertVendorLineItems(supabase as never, CLAIMED, [])

    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('rollbackUnclaimedInvoice', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes the invoice when this request is the one that inserted it', async () => {
    const supabase = makeSupabase({ work_order_invoices: [{ data: null, error: null }] })

    await rollbackUnclaimedInvoice(supabase as never, {
      ok: true, invoiceId: 'inv_1', invoiceNumber: 'INV-2026-00001', insertedByThisRequest: true,
    })

    expect(supabase.calls.some((c) => c.method === 'delete')).toBe(true)
  })

  it('leaves an invoice an earlier attempt created completely alone', async () => {
    const supabase = makeSupabase({})

    await rollbackUnclaimedInvoice(supabase as never, {
      ok: true, invoiceId: 'inv_existing', invoiceNumber: null, insertedByThisRequest: false,
    })

    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('is a no-op for a completion that never had an invoice (no line items)', async () => {
    const supabase = makeSupabase({})

    await rollbackUnclaimedInvoice(supabase as never, {
      ok: true, invoiceId: null, invoiceNumber: null, insertedByThisRequest: false,
    })

    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('finalizeVendorCompletion', () => {
  beforeEach(() => vi.clearAllMocks())

  const baseInput = {
    claimed:        CLAIMED,
    safeLineItems:  LINE_ITEMS,
    subtotal:       150,
    notes:          'All done',
    token:          'tok_1',
    previousStatus: 'assigned',
  }

  it('writes line items, the audit row, the status update, and the events', async () => {
    const supabase = makeSupabase({
      work_order_line_items: [{ data: null, error: null }],
      work_order_updates:    [{ data: null, error: null }],
    })

    await finalizeVendorCompletion(supabase as never, {
      ...baseInput,
      invoiceResult: { ok: true, invoiceId: 'inv_1', invoiceNumber: 'INV-2026-00001', insertedByThisRequest: true },
    })

    expect(supabase.calls.some((c) => c.table === 'work_order_line_items' && c.method === 'insert')).toBe(true)
    expect(supabase.calls.some((c) => c.table === 'work_order_updates'    && c.method === 'insert')).toBe(true)
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'work-order/invoice-submitted' }))
  })

  it('does not re-audit an invoice a previous attempt already created', async () => {
    const supabase = makeSupabase({
      work_order_line_items: [{ data: null, error: null }],
      work_order_updates:    [{ data: null, error: null }],
    })

    await finalizeVendorCompletion(supabase as never, {
      ...baseInput,
      invoiceResult: { ok: true, invoiceId: 'inv_existing', invoiceNumber: null, insertedByThisRequest: false },
    })

    expect(logAuditEvent).not.toHaveBeenCalled()
    // The completion itself still finalizes — the invoice is already there.
    expect(supabase.calls.some((c) => c.table === 'work_order_updates' && c.method === 'insert')).toBe(true)
  })
})

describe('logVendorInvoiceCreated', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records the invoice against the org with no actor (unauthenticated vendor route)', async () => {
    await logVendorInvoiceCreated(CLAIMED, 'inv_1', 'INV-2026-00001', 150)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      orgId:      'org_1',
      action:     'work_order.invoice.created',
      targetType: 'work_order_invoice',
      targetId:   'inv_1',
    }))
  })
})
