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

import {
  dailyMaintenanceScheduleCheck,
  maintenanceSchedulesOrg,
} from '@/lib/inngest/functions/cron/maintenance-schedules'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

// Queue-based `.from(table)` mock — see unit/stubs/supabase-query-double.ts.
// `work_orders` and `maintenance_schedules` are each queried multiple times
// per run (due-soon pass, overdue pass, per-schedule idempotency checks,
// vacancy-gap batch query), so a fixed per-table response isn't enough —
// order matters.
function makeSupabase(queued: Record<string, TableSpec>) {
  return createSupabaseDouble(queued)
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

const NOW_MS = new Date('2026-07-22T13:00:00.000Z').getTime()

function orgEvent(orgId = 'org_1') {
  return { data: { org_id: orgId, now_ms: NOW_MS } }
}

// Every pass the per-org handler runs unconditionally, even when there's
// nothing to do for the passes under test — these are the empty defaults for
// the no-op / most-passes-quiet cases.
function baseTables() {
  return {
    properties: [{ data: [], error: null }],  // vacancy-gap pass — no properties, short-circuits
  }
}

describe('dailyMaintenanceScheduleCheck (dispatcher)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW_MS))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('dispatches nothing when no org has an active schedule or an active property', async () => {
    const supabase = makeSupabase({
      maintenance_schedules: [{ data: [], error: null }],  // org discovery
      properties:            [{ data: [], error: null }],  // org discovery
      organizations:         [{ data: [], error: null }],  // 30-day milestone
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyMaintenanceScheduleCheck, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('fans out one org/maintenance_schedules.requested per org, unioning schedule-owning and property-owning orgs', async () => {
    const supabase = makeSupabase({
      // org_1 appears in both source queries — it must be dispatched once.
      maintenance_schedules: [{ data: [{ org_id: 'org_1' }, { org_id: 'org_2' }, { org_id: 'org_1' }], error: null }],
      properties:            [{ data: [{ org_id: 'org_1' }, { org_id: 'org_3' }], error: null }],
      organizations:         [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyMaintenanceScheduleCheck, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 3 })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-maintenance-schedules', [
      { name: 'org/maintenance_schedules.requested', data: { org_id: 'org_1', now_ms: NOW_MS } },
      { name: 'org/maintenance_schedules.requested', data: { org_id: 'org_2', now_ms: NOW_MS } },
      { name: 'org/maintenance_schedules.requested', data: { org_id: 'org_3', now_ms: NOW_MS } },
    ])
  })

  it('discovers orgs through paginated scans, so a >1000-row schedule table still dispatches every tenant', async () => {
    // The dispatcher's org discovery is the exact place PostgREST's 1000-row
    // cap used to silently drop tenants: rows 1000+ were never read, so those
    // orgs never got a per-org event and simply stopped being processed.
    const schedules = Array.from({ length: 2_400 }, (_, i) => ({ org_id: `org_${i}` }))
    const supabase = makeSupabase({
      maintenance_schedules: [{ data: schedules, error: null }],
      properties:            [{ data: [], error: null }],
      organizations:         [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyMaintenanceScheduleCheck, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 2_400 })
    const fanOut = step.sendEvent.mock.calls.find((c) => c[0] === 'fan-out-maintenance-schedules')!
    const dispatchedOrgIds = (fanOut[1] as { data: { org_id: string } }[]).map((e) => e.data.org_id)
    expect(dispatchedOrgIds).toContain('org_0')
    expect(dispatchedOrgIds).toContain('org_2399')   // past the cap — the tenant truncation used to eat
  })

  it('upserts the thirty-day milestone for orgs created in the 30–32 day window', async () => {
    const supabase = makeSupabase({
      maintenance_schedules: [{ data: [], error: null }],
      properties:            [{ data: [], error: null }],
      organizations:         [{ data: [{ id: 'org_new' }], error: null }],
      org_milestones:        [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(dailyMaintenanceScheduleCheck, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const upsert = supabase.calls.find((c) => c.table === 'org_milestones' && c.method === 'upsert')
    expect(upsert?.args[0]).toEqual([{ org_id: 'org_new', milestone: 'thirty_days' }])
    expect(upsert?.args[1]).toEqual({ onConflict: 'org_id,milestone', ignoreDuplicates: true })
  })
})

describe('maintenanceSchedulesOrg (per-org handler)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW_MS))
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
    const result = await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', checked: 0, escalated: 0, gapSuggestions: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('scopes every pass to the event org_id', async () => {
    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: [], error: null },
        { data: [], error: null },
      ],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent('org_scoped'),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const orgFilters = supabase.calls.filter((c) => c.method === 'eq' && c.args[0] === 'org_id')
    expect(orgFilters.length).toBeGreaterThan(0)
    expect(orgFilters.every((c) => c.args[1] === 'org_scoped')).toBe(true)
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
        { data: null, error: null }, // next_due_date advance update
      ],
      work_orders: [
        { data: null, error: null },             // existing-WO idempotency check — none
        { data: { id: 'wo_new' }, error: null },  // insert .select().single()
      ],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', checked: 1, escalated: 0, gapSuggestions: 0 })

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
        // The escalation is now an optimistic-locked update that RETURNS the
        // rows it changed (`.neq('priority','urgent').select('id')`), and the
        // note + audit are written only for those rows. A fixture returning no
        // rows now means "someone already escalated it", so it has to return
        // the row for the happy path.
        { data: [{ id: 'wo_open' }], error: null }, // priority update
      ],
      work_order_updates: [{ data: null, error: null }],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', checked: 0, escalated: 1, gapSuggestions: 0 })

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

  // A step retry re-runs this whole body. The escalation update is
  // optimistic-locked on `.neq('priority','urgent')`, so the second pass
  // matches zero rows — and the note must not be appended again. This was a
  // known open gap in unit/guardrails/inngest-insert-idempotency.test.ts,
  // closed by copying the guard cron/work-order-ops.ts already used.
  it('writes no second escalation note when the work order is already urgent', async () => {
    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: [], error: null },
        {
          data: [{
            id: 'sched_2', name: 'Gutter cleaning', estimated_cost: 100, next_due_date: '2026-07-10',
            assigned_vendor_id: null, property_id: 'prop_2', org_id: 'org_1',
            properties: { name: 'Ridge House' }, vendors: null,
          }],
          error: null,
        },
      ],
      work_orders: [
        { data: { id: 'wo_open', priority: 'medium', status: 'in_progress' }, error: null },
        { data: [], error: null },   // optimistic lock matched nothing — already urgent
      ],
      work_order_updates: [{ data: null, error: null }],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(supabase.calls.some((c) => c.table === 'work_order_updates' && c.method === 'insert')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
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
    const result = await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', checked: 1, escalated: 0, gapSuggestions: 0 })
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.maintenance-cron.invalid_due_date', orgId: 'org_1' }),
    )
    // No WO was ever attempted for the malformed-date schedule.
    expect(supabase.calls.some((c) => c.table === 'work_orders')).toBe(false)
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('walks every page of a >1000-schedule org rather than stopping at PostgREST max_rows', async () => {
    // Reminder-only schedules (auto_create_wo=false, outside no seasonal
    // window) do no writes, so this isolates the read: `checked` must equal
    // the whole seeded set, not the first 1000 rows.
    const dueSchedules = Array.from({ length: 2_100 }, (_, i) => ({
      id: `sched_${i}`, name: `Filter change ${i}`, schedule_type: 'routine', frequency: 'monthly',
      estimated_cost: null, instructions: null, auto_create_wo: false,
      next_due_date: '2026-07-27', active_from_month: null, active_to_month: null,
      assigned_vendor_id: null, property_id: 'prop_1', org_id: 'org_1',
      properties: { name: 'Lakeview Cabin' }, vendors: null,
    }))

    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: dueSchedules, error: null }, // find-due-schedules
        { data: [], error: null },           // find-overdue-schedules
      ],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toMatchObject({ checked: 2_100 })
    // Three pages requested for the due-schedule scan.
    const dueRanges = supabase.calls.filter((c) => c.table === 'maintenance_schedules' && c.method === 'range')
    expect(dueRanges.slice(0, 3).map((c) => c.args)).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
})
