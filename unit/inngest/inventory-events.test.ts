import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn() } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmEmails: vi.fn(),
}))
vi.mock('@/lib/resend/emails/pm-alert', () => ({
  renderPmAlert: vi.fn(async () => '<html>pm-alert</html>'),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { handleInventoryCountSubmitted } from '@/lib/inngest/functions/inventory-events'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { getPmEmails } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

// Queue-based mock: each `.from(table)` call consumes the next queued
// response for that table, in call order, regardless of whether the chain
// terminates in .single()/.maybeSingle() or is awaited directly (`.then`).
// handleInventoryCountSubmitted re-queries several tables (purchase_orders,
// inventory_items, bookings) more than once per run, so a fixed per-table
// canned response isn't enough — this is the same pattern used in
// checklist-broadcast.test.ts.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.insert = (...a: unknown[]) => record('insert', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
})

describe('handleInventoryCountSubmitted', () => {
  it('is a no-op when the count session does not belong to this org', async () => {
    const supabase = makeSupabase({
      inventory_counts: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleInventoryCountSubmitted, {
      event: { data: { count_id: 'count_1', property_id: 'prop_1', org_id: 'org_1' } },
      step:  runAllStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ count_id: 'count_1', purchaseOrderCreated: false })
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('inventory_counts')
  })

  it('is a no-op when everything counted is at or above par', async () => {
    const supabase = makeSupabase({
      inventory_counts:      [{ data: { id: 'count_1' }, error: null }],
      inventory_count_items: [{ data: [{ inventory_item_id: 'item_1', quantity_counted: 10 }], error: null }],
      inventory_items:       [
        { data: [{ id: 'item_1', name: 'Paper Towels', category: 'paper_goods', unit: 'roll', par_level: 10, low_stock_threshold_pct: 50 }], error: null },
        { data: null, error: null }, // bulk upsert of current_quantity
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleInventoryCountSubmitted, {
      event: { data: { count_id: 'count_1', property_id: 'prop_1', org_id: 'org_1' } },
      step:  runAllStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ count_id: 'count_1', purchaseOrderCreated: false })
    expect(supabase.calls.some((c) => c.table === 'purchase_orders')).toBe(false)
  })

  it('creates a purchase order for below-par items when it is not a same-day flip', async () => {
    const supabase = makeSupabase({
      inventory_counts:      [{ data: { id: 'count_1' }, error: null }],
      inventory_count_items: [{ data: [{ inventory_item_id: 'item_1', quantity_counted: 2 }], error: null }],
      inventory_items: [
        { data: [{ id: 'item_1', name: 'Toilet Paper', category: 'paper_goods', unit: 'roll', par_level: 10, low_stock_threshold_pct: 50 }], error: null },
        { data: null, error: null }, // bulk upsert
      ],
      purchase_orders: [
        { data: null, error: null },          // existing-PO check — none found
        { data: { id: 'po_1' }, error: null }, // insert + select('id').single()
        { data: null, error: null },          // update status -> 'sent'
        { data: null, error: null },          // mark-po-email-status update
      ],
      purchase_order_items: [{ data: null, error: null }],
      org_milestones:       [{ data: null, error: null }],
      bookings:              [{ data: [], error: null }], // no checkout today -> same-day flip short-circuits false
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleInventoryCountSubmitted, {
      event: { data: { count_id: 'count_1', property_id: 'prop_1', org_id: 'org_1' } },
      step:  runAllStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({
      count_id: 'count_1', purchaseOrderCreated: true, purchaseOrderId: 'po_1', itemCount: 1, isSameDayFlip: false,
    })

    const itemsInsert = supabase.calls.find((c) => c.table === 'purchase_order_items' && c.method === 'insert')
    expect(itemsInsert?.args[0]).toEqual([
      expect.objectContaining({
        purchase_order_id: 'po_1', inventory_item_id: 'item_1', item_name: 'Toilet Paper',
        current_quantity: 2, par_level: 10, quantity_to_buy: 8, unit: 'roll',
      }),
    ])
    // Not a same-day flip -> no immediate PM email
    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('does not create a duplicate purchase order when one already exists for this count (idempotency)', async () => {
    const supabase = makeSupabase({
      inventory_counts:      [{ data: { id: 'count_1' }, error: null }],
      inventory_count_items: [{ data: [{ inventory_item_id: 'item_1', quantity_counted: 1 }], error: null }],
      inventory_items: [
        { data: [{ id: 'item_1', name: 'Paper Towels', category: 'paper_goods', unit: 'roll', par_level: 5, low_stock_threshold_pct: 100 }], error: null },
        { data: null, error: null },
      ],
      purchase_orders: [
        { data: { id: 'po_existing' }, error: null }, // existing-PO check — found
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleInventoryCountSubmitted, {
      event: { data: { count_id: 'count_1', property_id: 'prop_1', org_id: 'org_1' } },
      step:  runAllStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({
      count_id: 'count_1', purchaseOrderCreated: true, purchaseOrderId: 'po_existing', itemCount: 1,
    })
    expect(supabase.calls.some((c) => c.table === 'purchase_orders' && c.method === 'insert')).toBe(false)
    expect(supabase.calls.some((c) => c.table === 'purchase_order_items')).toBe(false)
  })

  it('sends an immediate PM email for a same-day flip', async () => {
    const supabase = makeSupabase({
      inventory_counts:      [{ data: { id: 'count_1' }, error: null }],
      inventory_count_items: [{ data: [{ inventory_item_id: 'item_1', quantity_counted: 0 }], error: null }],
      inventory_items: [
        { data: [{ id: 'item_1', name: 'Coffee Pods', category: 'kitchen', unit: 'box', par_level: 4, low_stock_threshold_pct: 100 }], error: null },
        { data: null, error: null },
      ],
      purchase_orders: [
        { data: null, error: null },          // existing-PO check — none found
        { data: { id: 'po_2' }, error: null }, // insert + select
        { data: null, error: null },          // update status -> 'sent'
        { data: null, error: null },          // mark-po-email-status update
        { data: null, error: null },          // update order_email_sent -> true
      ],
      purchase_order_items: [{ data: null, error: null }],
      org_milestones:       [{ data: null, error: null }],
      bookings: [
        { data: [{ id: 'bk_1' }], error: null }, // checkout today
        { data: [{ id: 'bk_2' }], error: null }, // incoming today/tomorrow
      ],
      properties: [{ data: { name: 'The Lakehouse' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue(['pm@example.com'])

    const result = await invokeHandler(handleInventoryCountSubmitted, {
      event: { data: { count_id: 'count_1', property_id: 'prop_1', org_id: 'org_1' } },
      step:  runAllStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({
      count_id: 'count_1', purchaseOrderCreated: true, purchaseOrderId: 'po_2', itemCount: 1, isSameDayFlip: true,
    })
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'pm@example.com', subject: expect.stringContaining('Immediate Restock') }),
      { idempotencyKey: 'po-email-immediate-po_2' },
    )
    const emailSentUpdate = supabase.calls.find(
      (c) => c.table === 'purchase_orders' && c.method === 'update' && JSON.stringify(c.args[0]).includes('order_email_sent'),
    )
    expect(emailSentUpdate?.args[0]).toEqual({ order_email_sent: true })
  })
})
