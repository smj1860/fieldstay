import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Stripe from 'stripe'

vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { handleWorkOrderInvoiceRefunded } from '@/app/api/webhooks/stripe/handlers/work-order-invoice-refund'
import { logAuditEvent } from '@/lib/audit'

// ============================================================================
// This is the FieldStay-side half of a Stripe-dashboard refund: without it, a
// dashboard refund leaves the invoice claiming 'paid', the expense sitting on
// the owner's P&L, and work_orders.actual_cost wrong. See the header comment
// in work-order-invoice-refund.ts for the destination-charge context.
//
// charge.refunded reports `amount_refunded` as a CUMULATIVE total, not a
// delta, and Stripe delivers at-least-once with no ordering guarantee between
// distinct events — both properties are exercised directly rather than
// assumed.
// ============================================================================

interface Call { table: string; method: string; args: unknown[] }

function makeSupabase(invoiceRow: Record<string, unknown> | null) {
  const calls: Call[] = []
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)

    chain.maybeSingle = () =>
      Promise.resolve(table === 'work_order_invoices' ? { data: invoiceRow, error: null } : { data: null, error: null })
    // Every write chain here ends without .select()/.maybeSingle() — the
    // builder itself is awaited, so it must be thenable.
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
    return chain
  })
  return { from, calls } as unknown as Parameters<typeof handleWorkOrderInvoiceRefunded>[0]
}

function findCall(calls: Call[], table: string, method: string): Call | undefined {
  return calls.find((c) => c.table === table && c.method === method)
}

/** A minimal Stripe.Charge, typed loosely — only the fields the handler reads. */
function charge(overrides: Partial<{
  payment_intent: string | null
  amount_refunded: number
  amount_captured: number
}> = {}): Stripe.Charge {
  return {
    payment_intent:  'pi_1',
    amount_refunded: 0,
    amount_captured: 20_000,
    ...overrides,
  } as unknown as Stripe.Charge
}

const baseInvoice = (overrides: Record<string, unknown> = {}) => ({
  id:              'inv_1',
  org_id:          'org_1',
  work_order_id:   'wo_1',
  vendor_id:       'v_1',
  property_id:     'p_1',
  total:           200,
  status:          'paid',
  amount_refunded: 0,
  ...overrides,
})

describe('handleWorkOrderInvoiceRefunded', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a no-op when the payment intent matches no invoice of ours', async () => {
    const supabase = makeSupabase(null)
    await handleWorkOrderInvoiceRefunded(supabase as never, charge({ amount_refunded: 20_000 }))

    expect((supabase as unknown as { calls: Call[] }).calls.some((c) => c.method === 'update' || c.method === 'upsert')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('marks a full refund and posts a matching negative expense', async () => {
    const supabase = makeSupabase(baseInvoice())
    await handleWorkOrderInvoiceRefunded(supabase as never, charge({ amount_refunded: 20_000, amount_captured: 20_000 }))

    const calls = (supabase as unknown as { calls: Call[] }).calls

    const invoiceUpdate = findCall(calls, 'work_order_invoices', 'update')
    expect(invoiceUpdate?.args[0]).toMatchObject({ status: 'refunded', amount_refunded: 200 })

    const credit = findCall(calls, 'owner_transactions', 'upsert')
    expect(credit?.args[0]).toMatchObject({
      source:              'wo_invoice_refund',
      source_reference_id: 'wo_1',
      transaction_type:    'expense',
      category:            'maintenance',
      amount:              -200,
    })
    // NOT ignoreDuplicates — a second, larger partial refund must be able to
    // grow this row, unlike the original paid-expense upsert next to it.
    expect(credit?.args[1]).toMatchObject({ onConflict: 'source_reference_id,source' })
    expect(credit?.args[1]).not.toHaveProperty('ignoreDuplicates', true)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'work_order.invoice.refunded',
      metadata: expect.objectContaining({ full: true }),
    }))
  })

  it('marks a partial refund distinctly from a full one', async () => {
    const supabase = makeSupabase(baseInvoice())
    await handleWorkOrderInvoiceRefunded(supabase as never, charge({ amount_refunded: 5_000, amount_captured: 20_000 }))

    const calls = (supabase as unknown as { calls: Call[] }).calls
    const invoiceUpdate = findCall(calls, 'work_order_invoices', 'update')
    expect(invoiceUpdate?.args[0]).toMatchObject({ status: 'partially_refunded', amount_refunded: 50 })

    const credit = findCall(calls, 'owner_transactions', 'upsert')
    expect(credit?.args[0]).toMatchObject({ amount: -50 })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ full: false }),
    }))
  })

  // ── Cumulative, not incremental ──────────────────────────────────────────
  // charge.refunded resends the RUNNING TOTAL on every delivery. A second,
  // larger partial refund's event must overwrite the credit row's amount
  // (grow it), not add a second row or a delta on top of the first.
  it('grows the credit to match a larger cumulative amount on a second partial refund', async () => {
    // The invoice already reflects the FIRST partial refund's outcome.
    const supabase = makeSupabase(baseInvoice({ status: 'partially_refunded', amount_refunded: 50 }))
    await handleWorkOrderInvoiceRefunded(supabase as never, charge({ amount_refunded: 15_000, amount_captured: 20_000 }))

    const calls = (supabase as unknown as { calls: Call[] }).calls
    const invoiceUpdate = findCall(calls, 'work_order_invoices', 'update')
    expect(invoiceUpdate?.args[0]).toMatchObject({ status: 'partially_refunded', amount_refunded: 150 })

    const credit = findCall(calls, 'owner_transactions', 'upsert')
    // The FULL new total, not the $100 delta — upsert-overwrite depends on it.
    expect(credit?.args[0]).toMatchObject({ amount: -150 })
  })

  // ── Idempotent on a literal retry ────────────────────────────────────────
  it('is a no-op when the identical cumulative amount is redelivered', async () => {
    const supabase = makeSupabase(baseInvoice({ status: 'refunded', amount_refunded: 200 }))
    await handleWorkOrderInvoiceRefunded(supabase as never, charge({ amount_refunded: 20_000, amount_captured: 20_000 }))

    const calls = (supabase as unknown as { calls: Call[] }).calls
    expect(calls.some((c) => c.method === 'update' || c.method === 'upsert')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  // ── Out-of-order delivery ────────────────────────────────────────────────
  // Stripe's at-least-once delivery carries no ordering guarantee between two
  // DISTINCT events. If a later, larger refund's event is somehow processed
  // first, a resend of an earlier, smaller one must not roll the recorded
  // total backward.
  it('ignores a smaller cumulative amount than what is already recorded', async () => {
    const supabase = makeSupabase(baseInvoice({ status: 'partially_refunded', amount_refunded: 150 }))
    await handleWorkOrderInvoiceRefunded(supabase as never, charge({ amount_refunded: 5_000, amount_captured: 20_000 }))

    const calls = (supabase as unknown as { calls: Call[] }).calls
    expect(calls.some((c) => c.method === 'update' || c.method === 'upsert')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('ignores a charge with no payment_intent', async () => {
    const supabase = makeSupabase(baseInvoice())
    await handleWorkOrderInvoiceRefunded(supabase as never, charge({ payment_intent: null, amount_refunded: 20_000 }))

    const calls = (supabase as unknown as { calls: Call[] }).calls
    expect(calls.length).toBe(0)
  })

  // ── actual_cost adjustment guard ─────────────────────────────────────────
  // Only clear/adjust work_orders.actual_cost when it still equals what the
  // ORIGINAL payment wrote — mirroring the paid handler's own
  // `.is('actual_cost', null)` guard against clobbering a PM's manual entry.
  it('scopes the actual_cost write to rows still holding the original paid total', async () => {
    const supabase = makeSupabase(baseInvoice())
    await handleWorkOrderInvoiceRefunded(supabase as never, charge({ amount_refunded: 20_000, amount_captured: 20_000 }))

    const calls = (supabase as unknown as { calls: Call[] }).calls
    const costUpdate = findCall(calls, 'work_orders', 'update')
    expect(costUpdate?.args[0]).toEqual({ actual_cost: null })

    // The guard clause itself: some .eq() call on work_orders pins the
    // precondition on the ORIGINAL total, not an unconditional write.
    const eqOnWorkOrders = calls.filter((c) => c.table === 'work_orders' && c.method === 'eq')
    expect(eqOnWorkOrders.some((c) => c.args[0] === 'actual_cost' && c.args[1] === 200)).toBe(true)
  })
})
