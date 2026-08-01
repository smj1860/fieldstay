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
import { markWorkVerified } from '@/app/(dashboard)/maintenance/work-order-actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'in', 'is', 'order', 'range']) {
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
