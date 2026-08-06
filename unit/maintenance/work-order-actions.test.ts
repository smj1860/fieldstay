import { describe, it, expect, vi, beforeEach } from 'vitest'

// Next.js aliases this to an empty module at build time; vitest needs an
// explicit stub since the real package isn't installed as a dependency.
vi.mock('server-only', () => ({}))

vi.mock('@/lib/auth', () => ({ requireOrgRole: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/inngest/client', () => {
  const send = vi.fn()
  return {
    inngest: { send },
    sendEventAsync: (...args: unknown[]) => { void Promise.resolve(send(...args)).catch(() => undefined) },
  }
})
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { requireOrgRole } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { reportError } from '@/lib/observability/report-error'
import { addWorkOrderLineItem, markWorkVerified } from '@/app/(dashboard)/maintenance/work-order-actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'in', 'is', 'order', 'range', 'limit']) {
      chain[m] = vi.fn((...args: unknown[]) => { calls.push({ table, method: m, args }); return chain })
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

// markWorkVerified is the WO detail "verify" button (wired through
// components/work-orders/use-work-order-actions.ts) — the third of the three
// ways a PM completes a work order. It used to write `status = 'completed'`
// and stop: no work-order/completed event, so no maintenance expense ever
// reached owner_transactions and the source maintenance schedule never
// advanced past its old next_due_date.
describe('maintenance/work-order-actions — markWorkVerified', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('fires work-order/completed, logs the status change, and advances the source schedule', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: { vendor_id: null, status: 'in_progress' } },
        { data: { id: 'wo_1', property_id: 'prop_1', org_id: 'org_1', source_schedule_id: 'sched_1', source: 'maintenance_schedule', actual_cost: 175, estimated_cost: 150 } },
      ],
      work_order_updates:    [{ error: null }],
      maintenance_schedules: [
        { data: [{ id: 'sched_1', schedule_type: 'routine', frequency: 'quarterly', next_due_date: '2026-08-01', auto_create_wo: true }] },
        { error: null },
      ],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership, user: { id: 'user_1' },
    } as never)

    await markWorkVerified('wo_1')

    expect(inngest.send).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'work-order/completed',
        data: expect.objectContaining({ work_order_id: 'wo_1', property_id: 'prop_1', actual_cost: 175 }),
      }),
    ])
    expect(supabase.from).toHaveBeenCalledWith('work_order_updates')
    expect(supabase.from).toHaveBeenCalledWith('maintenance_schedules')

    const update = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'update')
    expect(update?.args[0]).toMatchObject({ status: 'completed' })
    expect((update?.args[0] as Record<string, unknown>).completed_date).toBeTruthy()
    expect((update?.args[0] as Record<string, unknown>).completion_verified_by).toBe('user_1')
  })

  it('claims the row with .neq(status, completed) and fans out nothing on a double-click', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: { vendor_id: null, status: 'completed' } },
        { data: null },   // the claim matched nothing — already completed
      ],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership, user: { id: 'user_1' },
    } as never)

    await markWorkVerified('wo_1')

    expect(supabase.calls).toContainEqual(
      expect.objectContaining({ table: 'work_orders', method: 'neq', args: ['status', 'completed'] })
    )
    expect(inngest.send).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalledWith('maintenance_schedules')
  })

  it('still refuses to complete a vendor-assigned work order outside the vendor portal', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: { vendor_id: 'vendor_1', status: 'assigned' } }],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership, user: { id: 'user_1' },
    } as never)

    await expect(markWorkVerified('wo_1')).rejects.toThrow(/vendor/i)
    expect(inngest.send).not.toHaveBeenCalled()
  })
})

// ============================================================================
// sort_order decides the order line items print in — on the work-order detail
// page, on the board, and on the invoice at /invoices/[invoiceId], all three of
// which read them back with `.order('sort_order')`.
//
// It used to default to a flat 0, and line-items-editor.tsx (the only UI that
// adds one) never passed a value, so every hand-entered line on a work order
// carried the SAME sort key. Sorting rows that all tie leaves the order to
// Postgres, which may return a different one on a different run — so the
// document a vendor is paid against, and which feeds the owner statement,
// could shuffle its own lines between loads.
//
// reorderWorkOrderLineItems existed to let a PM drag lines into place, but the
// drag control was never built. Deleting it and giving the column a real
// sequence is the fix; these pin the sequence.
// ============================================================================
describe('maintenance/work-order-actions — addWorkOrderLineItem sort_order', () => {
  beforeEach(() => { vi.clearAllMocks() })

  function insertedRow(supabase: ReturnType<typeof makeSupabase>) {
    // from() is called twice: the MAX(sort_order) probe, then the insert.
    return supabase.from.mock.results[1]!.value.insert.mock.calls[0]![0]
  }

  const LINE = {
    line_type:   'labor' as const,
    description: 'Replace capacitor',
    quantity:    1,
    unit:        null,
    unit_cost:   180,
  }

  it('starts the first line item on a work order at 0', async () => {
    const supabase = makeSupabase({ work_order_line_items: [{ data: null }, { error: null }] })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

    await addWorkOrderLineItem('wo_1', LINE)

    expect(insertedRow(supabase).sort_order).toBe(0)
  })

  it('gives the next line item a HIGHER number, not another 0', async () => {
    const supabase = makeSupabase({
      work_order_line_items: [{ data: { sort_order: 4 } }, { error: null }],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

    await addWorkOrderLineItem('wo_1', LINE)

    expect(insertedRow(supabase).sort_order).toBe(5)
  })

  it('scopes the MAX probe to the work order AND the caller org', async () => {
    const supabase = makeSupabase({
      work_order_line_items: [{ data: { sort_order: 0 } }, { error: null }],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

    await addWorkOrderLineItem('wo_1', LINE)

    const eqArgs = supabase.calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqArgs).toContainEqual(['work_order_id', 'wo_1'])
    expect(eqArgs).toContainEqual(['org_id', 'org_1'])
  })

  // A failed probe must not silently reinstate the flat-0 default it exists to
  // remove — but it also must not stop the PM adding the line. Report, fall
  // back, let the read-side tiebreakers carry the order.
  it('reports a failed probe and still writes the line', async () => {
    const supabase = makeSupabase({
      work_order_line_items: [{ data: null, error: { message: 'boom' } }, { error: null }],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

    await addWorkOrderLineItem('wo_1', LINE)

    expect(reportError).toHaveBeenCalled()
    expect(insertedRow(supabase).sort_order).toBe(0)
  })

  it('honours an explicit sort_order without probing', async () => {
    const supabase = makeSupabase({ work_order_line_items: [{ error: null }] })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

    await addWorkOrderLineItem('wo_1', { ...LINE, sort_order: 9 })

    expect(supabase.from.mock.results[0]!.value.insert.mock.calls[0]![0].sort_order).toBe(9)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })
})
