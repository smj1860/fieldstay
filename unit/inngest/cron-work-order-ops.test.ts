import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(async () => undefined),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(async () => undefined),
}))

import { dailyWorkOrderOps } from '@/lib/inngest/functions/cron/work-order-ops'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { createPmNotification } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast.
// `work_orders` is queried both for the aging pass and (per auto-created
// schedule) for the idempotency check + insert, so a fixed per-table
// response isn't enough.
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
    for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lte', 'lt', 'neq', 'like', 'order', 'limit', 'is']) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }
    for (const m of ['insert', 'update', 'upsert', 'delete']) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

describe('dailyWorkOrderOps', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T13:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('is a no-op when there are no aging work orders and no due auto-WO schedules', async () => {
    const supabase = makeSupabase({
      work_orders:            [{ data: [], error: null }],
      maintenance_schedules:  [{ data: [], error: null }],
      processed_webhooks:     [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyWorkOrderOps, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ aging_escalated: 0, auto_wos_attempted: 0, webhook_inbox_cleaned: true })
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('escalates a stale work order to urgent priority, logs it, and fires an aging-escalated event', async () => {
    const supabase = makeSupabase({
      work_orders: [
        {
          data: [{
            id: 'wo_1', org_id: 'org_1', property_id: 'prop_1', category: 'hvac',
            status: 'pending', priority: 'medium', created_at: '2026-07-10T00:00:00.000Z',
          }],
          error: null,
        },
        { data: null, error: null }, // update priority
      ],
      work_order_updates:    [{ data: null, error: null }],
      maintenance_schedules: [{ data: [], error: null }],
      processed_webhooks:    [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyWorkOrderOps, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect((result as { aging_escalated: number }).aging_escalated).toBe(1)

    const updateCall = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'update')
    expect(updateCall?.args[0]).toEqual({ priority: 'urgent' })

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:    'org_1',
        action:   'work_order.updated',
        targetId: 'wo_1',
        metadata: { change: 'auto_escalated_to_urgent' },
      }),
    )

    expect(step.sendEvent).toHaveBeenCalledWith(
      'send-escalation-event-wo_1',
      expect.objectContaining({
        name: 'work-order/aging-escalated',
        data: expect.objectContaining({ work_order_id: 'wo_1', org_id: 'org_1', new_priority: 'urgent' }),
      }),
    )
  })

  it('auto-creates a work order for a due schedule, resolves a specialty-hint vendor, and notifies the PM', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: [], error: null },       // aging pass — none
        { data: null, error: null },     // existing-WO idempotency check for the schedule
        { data: { id: 'wo_new' }, error: null }, // insert .select().single()
      ],
      maintenance_schedules: [
        {
          data: [{
            id: 'sched_1', name: 'Quarterly HVAC service', org_id: 'org_1', property_id: 'prop_1',
            next_due_date: '2026-07-22', frequency: 'quarterly', schedule_type: 'routine',
            assigned_vendor_id: null, vendor_specialty_hint: 'hvac', estimated_cost: 200,
            instructions: 'Service the unit', properties: { name: 'Lakeview Cabin' },
          }],
          error: null,
        },
        { data: null, error: null }, // next_due_date advance update
      ],
      vendors: [
        { data: { id: 'vendor_1' }, error: null }, // specialty-hint vendor lookup
      ],
      processed_webhooks: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyWorkOrderOps, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect((result as { auto_wos_attempted: number }).auto_wos_attempted).toBe(1)

    const insertCall = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'insert')
    expect(insertCall?.args[0]).toMatchObject({
      property_id: 'prop_1', org_id: 'org_1', vendor_id: 'vendor_1', category: 'hvac',
      title: 'Quarterly HVAC service', source: 'maintenance_schedule', source_schedule_id: 'sched_1',
      portal_enabled: false,
    })

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'work_order.created', targetId: 'wo_new' }),
    )
    expect(createPmNotification).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        orgId: 'org_1', type: 'work_order_created', href: '/maintenance/wo_new',
        dedupeKey: 'auto-wo-created-sched_1-2026-07-22',
      }),
    )
    expect(step.sendEvent).toHaveBeenCalledWith(
      'send-auto-create-event-sched_1',
      expect.objectContaining({ name: 'work-order/created' }),
    )
    // A vendor was resolved via the specialty hint, so no vendor-suggestion event should fire.
    expect(step.sendEvent).not.toHaveBeenCalledWith(
      'send-vendor-suggestion-event-sched_1',
      expect.anything(),
    )
  })

  it('skips auto-creating a work order when one already exists for the schedule + due date (idempotency)', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: [], error: null },              // aging pass — none
        { data: { id: 'existing_wo' }, error: null }, // idempotency check finds one
      ],
      maintenance_schedules: [
        {
          data: [{
            id: 'sched_1', name: 'Quarterly HVAC service', org_id: 'org_1', property_id: 'prop_1',
            next_due_date: '2026-07-22', frequency: 'quarterly', schedule_type: 'routine',
            assigned_vendor_id: 'vendor_pre', vendor_specialty_hint: 'hvac', estimated_cost: 200,
            instructions: 'Service the unit', properties: { name: 'Lakeview Cabin' },
          }],
          error: null,
        },
      ],
      processed_webhooks: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    await invokeHandler(dailyWorkOrderOps, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    // No insert, no audit log, no notification, no event — the existing WO short-circuits everything.
    expect(supabase.calls.some((c) => c.table === 'work_orders' && c.method === 'insert')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(createPmNotification).not.toHaveBeenCalled()
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})
