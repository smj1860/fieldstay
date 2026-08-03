import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))

import {
  logVendorInvoiceCreated,
  finalizeVendorCompletion,
  dispatchCompletionEvents,
} from '@/app/api/work-orders/[token]/complete/helpers'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'

/**
 * SCOPE NOTE. Every database write for a vendor completion now happens inside
 * the complete_work_order_via_token() RPC (migration 20260801200000) — the
 * claim, the invoice, the line items and the status-change row are one
 * transaction. The tests that used to live here for createVendorInvoice,
 * insertVendorLineItems, rollbackVendorInvoice and rollbackUnclaimedInvoice are
 * gone with those functions: a rolled-back transaction leaves nothing to
 * compensate for, so there is no compensating delete left to test.
 *
 * Those invariants are now enforced by the database and were verified against
 * the live E2E project directly (claim + invoice + 2 line items + 1 status row
 * in one call; a replay returning already_closed and writing nothing further;
 * an unpriced completion writing no invoice and leaving actual_cost untouched).
 *
 * What remains here is the non-transactional tail — the audit log and the
 * Inngest dispatch — which deliberately stays OUTSIDE the transaction, because
 * an event fired from inside one that later aborts cannot be unfired.
 */

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'in', 'not', 'is']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    // The source-turnover lookup now uses maybeSingle().
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

const CLAIMED = {
  id: 'wo_1', org_id: 'org_1', vendor_id: 'vendor_1', property_id: 'prop_1',
  wo_number: 'WO-1', source_turnover_id: null,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asClient = (s: ReturnType<typeof makeSupabase>) => s as any

describe('finalizeVendorCompletion', () => {
  beforeEach(() => vi.clearAllMocks())

  it('audits an invoice THIS request minted and fires the invoice event', async () => {
    const supabase = makeSupabase({})

    await finalizeVendorCompletion(asClient(supabase), {
      claimed:         CLAIMED,
      invoiceId:       'inv_1',
      invoiceNumber:   'INV-2026-00001',
      invoiceInserted: true,
      subtotal:        150,
      notes:           'done',
      token:           'tok_1',
    })

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'work_order.invoice.created', targetId: 'inv_1' }),
    )
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'work-order/invoice-submitted' }),
    )
  })

  it('does NOT re-audit an invoice an earlier attempt already created', async () => {
    // The RPC reports invoice_inserted=false when its ON CONFLICT DO NOTHING
    // found an existing row. A replay must not log a second "created" event
    // for an invoice that has already been audited once.
    const supabase = makeSupabase({})

    await finalizeVendorCompletion(asClient(supabase), {
      claimed:         CLAIMED,
      invoiceId:       'inv_existing',
      invoiceNumber:   null,
      invoiceInserted: false,
      subtotal:        150,
      notes:           null,
      token:           'tok_1',
    })

    expect(logAuditEvent).not.toHaveBeenCalled()
    // The event still fires — the completion itself is real either way.
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'work-order/invoice-submitted' }),
    )
  })

  it('writes NO database rows itself — every write belongs to the transaction', async () => {
    // The point of the RPC: if this function starts writing again, some part of
    // the completion is outside the transaction and can be half-applied.
    const supabase = makeSupabase({})

    await finalizeVendorCompletion(asClient(supabase), {
      claimed:         CLAIMED,
      invoiceId:       'inv_1',
      invoiceNumber:   'INV-2026-00001',
      invoiceInserted: true,
      subtotal:        150,
      notes:           'done',
      token:           'tok_1',
    })

    const writes = supabase.calls.filter((c) =>
      ['insert', 'update', 'upsert', 'delete'].includes(c.method))
    expect(writes).toEqual([])
  })
})

describe('dispatchCompletionEvents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fires the legacy portal event when the completion carried no invoice', async () => {
    const supabase = makeSupabase({})

    await dispatchCompletionEvents(asClient(supabase), CLAIMED, null, 'tok_1', 'no charge', 0)

    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'work-order/completed-via-portal' }),
    )
  })

  it('cascades turnover/completed for a linked turnover that is still open', async () => {
    const linked = { ...CLAIMED, source_turnover_id: 'to_1' }
    const supabase = makeSupabase({
      turnovers: [
        // 1st call: the read.  2nd call: the claiming UPDATE, which must match
        // a row before the event may fire.
        { data: { id: 'to_1', property_id: 'prop_1', org_id: 'org_1', status: 'in_progress' }, error: null },
        { data: { id: 'to_1' }, error: null },
      ],
    })

    await dispatchCompletionEvents(asClient(supabase), linked, 'inv_1', 'tok_1', null, 150)

    // The turnover must actually be CLOSED, not merely announced as closed.
    // Firing the event without writing status is what left the cleaning fee
    // posted against a turnover still sitting open on the board — and let a
    // later real completion fire the same event a second time.
    const statusWrite = supabase.calls.find(
      (c) => c.table === 'turnovers' && c.method === 'update',
    )
    expect(statusWrite?.args[0]).toMatchObject({ status: 'completed' })

    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'turnover/completed' }),
    )
  })

  it('does NOT fire turnover/completed when the claim matches zero rows', async () => {
    // Another path completed the turnover between our read and our update.
    // That path fires its own event; firing a second one double-counts the
    // completion metric and corrupts the derived duration.
    const linked = { ...CLAIMED, source_turnover_id: 'to_1' }
    const supabase = makeSupabase({
      turnovers: [
        { data: { id: 'to_1', property_id: 'prop_1', org_id: 'org_1', status: 'in_progress' }, error: null },
        { data: null, error: null },   // claim matched nothing
      ],
    })

    await dispatchCompletionEvents(asClient(supabase), linked, 'inv_1', 'tok_1', null, 150)

    expect(inngest.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'turnover/completed' }),
    )
  })

  it('does not re-complete a turnover that is already closed', async () => {
    const linked = { ...CLAIMED, source_turnover_id: 'to_1' }
    const supabase = makeSupabase({
      turnovers: [{ data: { id: 'to_1', property_id: 'prop_1', org_id: 'org_1', status: 'completed' }, error: null }],
    })

    await dispatchCompletionEvents(asClient(supabase), linked, 'inv_1', 'tok_1', null, 150)

    const names = vi.mocked(inngest.send).mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).not.toContain('turnover/completed')
  })
})

describe('logVendorInvoiceCreated', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records the invoice against the org with no actor (unauthenticated vendor route)', async () => {
    await logVendorInvoiceCreated(CLAIMED, 'inv_1', 'INV-2026-00001', 150)

    const arg = vi.mocked(logAuditEvent).mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(arg.orgId).toBe('org_1')
    expect(arg.targetType).toBe('work_order_invoice')
    expect(arg).not.toHaveProperty('actorId')
  })
})
