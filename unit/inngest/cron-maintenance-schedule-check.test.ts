import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(async () => undefined),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { dailyMaintenanceScheduleCheck } from '@/lib/inngest/functions/cron/maintenance-schedules'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast.
// `work_orders` and `maintenance_schedules` are each queried multiple times
// per run (due-soon pass, overdue pass, per-schedule idempotency checks,
// vacancy-gap batch query, 30-day milestone), so a fixed per-table response
// isn't enough — order matters.
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
    for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lte', 'lt', 'neq', 'order', 'limit', 'is']) {
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

// Every pass this function runs unconditionally, even when there's nothing
// to do for the passes under test — these are the empty defaults for the
// no-op / most-passes-quiet cases.
function baseTables() {
  return {
    properties:            [{ data: [], error: null }],  // vacancy-gap pass — no properties, short-circuits
    organizations:         [{ data: [], error: null }],  // 30-day milestone
  }
}

describe('dailyMaintenanceScheduleCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T13:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('is a no-op when there are no due-soon or overdue schedules and no properties', async () => {
    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: [], error: null }, // find-due-schedules
        { data: [], error: null }, // find-overdue-schedules
      ],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyMaintenanceScheduleCheck, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ checked: 0, escalated: 0, gapSuggestions: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('creates a WO for a due auto_create_wo schedule, advances next_due_date, and fires a vendor-portal event', async () => {
    const supabase = makeSupabase({
      maintenance_schedules: [
        {
          data: [{
            id: 'sched_1', name: 'Pool inspection', schedule_type: 'routine', frequency: 'monthly',
            estimated_cost: 150, instructions: 'Check chemicals', auto_create_wo: true,
            next_due_date: '2026-07-27', active_from_month: null, active_to_month: null,
            assigned_vendor_id: 'vendor_1', property_id: 'prop_1', org_id: 'org_1',
            properties: { name: 'Lakeview Cabin', city: 'Austin', state: 'TX' },
            vendors: { id: 'vendor_1', name: 'Pool Pros', email: 'pool@vendor.com', portal_enabled: true },
          }],
          error: null,
        }, // find-due-schedules
        { data: [], error: null }, // find-overdue-schedules
      ],
      work_orders: [
        { data: null, error: null },             // existing-WO idempotency check — none
        { data: { id: 'wo_new' }, error: null },  // insert .select().single()
      ],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyMaintenanceScheduleCheck, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ checked: 1, escalated: 0, gapSuggestions: 0 })

    const insertCall = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'insert')
    expect(insertCall?.args[0]).toMatchObject({
      property_id: 'prop_1', org_id: 'org_1', vendor_id: 'vendor_1', title: 'Pool inspection',
      source: 'maintenance_schedule', source_schedule_id: 'sched_1', priority: 'medium',
      portal_enabled: true,
    })

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'work_order.created', targetId: 'wo_new' }),
    )

    // Routine schedule → next_due_date advances by one month (2026-07-27 → 2026-08-27).
    const scheduleUpdate = supabase.calls.find((c) => c.table === 'maintenance_schedules' && c.method === 'update')
    expect(scheduleUpdate?.args[0]).toEqual({ next_due_date: '2026-08-27' })

    // Vendor has portal_enabled + email → fires the vendor-portal dispatch event.
    expect(step.sendEvent).toHaveBeenCalledWith(
      'fire-vendor-portal-sched_1',
      expect.objectContaining({
        name: 'work-order/created',
        data: expect.objectContaining({ work_order_id: 'wo_new', vendor_id: 'vendor_1', portal_enabled: true }),
      }),
    )
  })

  it('escalates an overdue schedule\'s existing open WO to urgent instead of creating a duplicate', async () => {
    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: [], error: null }, // find-due-schedules — nothing due soon
        {
          data: [{
            id: 'sched_2', name: 'Gutter cleaning', estimated_cost: 100, next_due_date: '2026-07-10',
            assigned_vendor_id: null, property_id: 'prop_2', org_id: 'org_1',
            properties: { name: 'Ridge House' }, vendors: null,
          }],
          error: null,
        }, // find-overdue-schedules
      ],
      work_orders: [
        { data: { id: 'wo_open', priority: 'medium', status: 'in_progress' }, error: null }, // existing open WO lookup
        { data: null, error: null }, // priority update
      ],
      work_order_updates: [{ data: null, error: null }],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyMaintenanceScheduleCheck, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ checked: 0, escalated: 1, gapSuggestions: 0 })

    const updateCall = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'update')
    expect(updateCall?.args[0]).toEqual({ priority: 'urgent' })
    expect(supabase.calls.some((c) => c.table === 'work_orders' && c.method === 'insert')).toBe(false)

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action:   'work_order.updated',
        targetId: 'wo_open',
        metadata: expect.objectContaining({ change: 'auto_escalated_to_urgent', maintenance_schedule_id: 'sched_2' }),
      }),
    )
  })

  it('reports and skips a schedule with an invalid next_due_date instead of throwing', async () => {
    const supabase = makeSupabase({
      maintenance_schedules: [
        {
          data: [{
            id: 'sched_bad', name: 'Bad date schedule', schedule_type: 'routine', frequency: 'monthly',
            estimated_cost: 50, instructions: null, auto_create_wo: true,
            next_due_date: 'not-a-date', active_from_month: null, active_to_month: null,
            assigned_vendor_id: null, property_id: 'prop_3', org_id: 'org_1',
            properties: { name: 'Broken Date House' }, vendors: null,
          }],
          error: null,
        },
        { data: [], error: null }, // find-overdue-schedules
      ],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyMaintenanceScheduleCheck, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ checked: 1, escalated: 0, gapSuggestions: 0 })
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.maintenance-cron.invalid_due_date', orgId: 'org_1' }),
    )
    // No WO was ever attempted for the malformed-date schedule.
    expect(supabase.calls.some((c) => c.table === 'work_orders')).toBe(false)
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})
