import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Stripe from 'stripe'

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { handleWorkOrderInvoicePaid } from '@/app/api/webhooks/stripe/handlers/work-order-invoice'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'

// Mirrors the `.eq('status', 'pending_payment')` idempotency guard in the
// real query: once the row is no longer pending, `.single()` finds no match
// and the update returns null data — exactly like Supabase's real behavior
// for a zero-row update+select.
function makeSupabase(invoiceRow: Record<string, unknown> | null) {
  const upsertSpy = vi.fn()
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    chain.update = vi.fn(() => chain)
    chain.upsert = vi.fn((payload: unknown, opts: unknown) => {
      upsertSpy(table, payload, opts)
      return Promise.resolve({ error: null })
    })
    chain.eq     = vi.fn(() => chain)
    chain.is     = vi.fn(() => Promise.resolve({ error: null }))
    chain.select = vi.fn(() => chain)
    chain.single = vi.fn(() =>
      table === 'work_order_invoices'
        ? Promise.resolve({ data: invoiceRow, error: null })
        : Promise.resolve({ data: null, error: null })
    )
    return chain
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from, upsertSpy } as any
}

const session = { payment_intent: 'pi_1' } as unknown as Stripe.Checkout.Session

describe('handleWorkOrderInvoicePaid', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('posts the expense exactly once on the first (pending -> paid) delivery', async () => {
    const supabase = makeSupabase({
      id: 'inv_1', work_order_id: 'wo_1', vendor_id: 'v_1', property_id: 'p_1', total: 250,
    })

    await handleWorkOrderInvoicePaid(supabase, session, 'inv_1', 'org_1')

    expect(supabase.upsertSpy).toHaveBeenCalledTimes(1)
    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'owner_transactions',
      expect.objectContaining({
        source:              'wo_completion',
        source_reference_id: 'wo_1',
        amount:              250,
      }),
      expect.objectContaining({ onConflict: 'source_reference_id,source', ignoreDuplicates: true }),
    )
    expect(inngest.send).toHaveBeenCalledTimes(1)
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
  })

  it('is a no-op on a retried delivery once the invoice is no longer pending_payment', async () => {
    // The .eq('status', 'pending_payment') filter means a retry (invoice
    // already marked 'paid' by the first delivery) matches zero rows.
    const supabase = makeSupabase(null)

    await handleWorkOrderInvoicePaid(supabase, session, 'inv_1', 'org_1')

    expect(supabase.upsertSpy).not.toHaveBeenCalled()
    expect(inngest.send).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
