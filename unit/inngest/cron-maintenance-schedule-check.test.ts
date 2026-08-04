import { DEFAULT_PAGE_SIZE as PAGE } from '@/lib/inngest/paginate'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent:  vi.fn(async () => undefined),
  logAuditEvents: vi.fn(async () => undefined),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import {
  dailyMaintenanceScheduleCheck,
  maintenanceSchedulesOrg,
} from '@/lib/inngest/functions/cron/maintenance-schedules'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent, logAuditEvents } from '@/lib/audit'
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

/** One row of find-overdue-schedules' shape (OverdueScheduleRow). */
function overdueSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sched_2', name: 'Gutter cleaning', estimated_cost: 100, next_due_date: '2026-07-10',
    assigned_vendor_id: null, property_id: 'prop_2', org_id: 'org_1',
    ...overrides,
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
        { data: [overdueSchedule()], error: null }, // find-overdue-schedules
      ],
      work_orders: [
        // Batched: ONE open-WO read for the whole batch, returning a list.
        { data: [{ id: 'wo_open', priority: 'medium', status: 'in_progress', source_schedule_id: 'sched_2' }], error: null },
        // The escalation is an optimistic-locked bulk update that RETURNS the
        // rows it changed (`.neq('priority','urgent').select('id')`), and the
        // notes + audit are written only for those rows. A fixture returning no
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

    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        action:   'work_order.updated',
        targetId: 'wo_open',
        metadata: expect.objectContaining({ change: 'auto_escalated_to_urgent', maintenance_schedule_id: 'sched_2' }),
      }),
    ])
  })

  // A step retry re-runs this whole body — and now a BATCH retry re-runs every
  // schedule in the batch, not just the one that failed, so the escalation
  // being idempotent is what makes batching safe at all. The bulk update is
  // optimistic-locked on `.neq('priority','urgent')`, so the second pass
  // matches zero rows and the notes must not be appended again.
  it('writes no second escalation note when the work order is already urgent', async () => {
    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: [], error: null },
        { data: [overdueSchedule()], error: null },
      ],
      work_orders: [
        { data: [{ id: 'wo_open', priority: 'medium', status: 'in_progress', source_schedule_id: 'sched_2' }], error: null },
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
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('skips an already-urgent open WO entirely — no update, no note', async () => {
    // The per-schedule version still spent a step and a round-trip to discover
    // there was nothing to do. A permanently-overdue schedule (one nothing
    // advances past its due date) is in this state every day forever, so it is
    // the dominant case in the set, not an edge one.
    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: [], error: null },
        { data: [overdueSchedule()], error: null },
      ],
      work_orders: [
        { data: [{ id: 'wo_open', priority: 'urgent', status: 'in_progress', source_schedule_id: 'sched_2' }], error: null },
      ],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(supabase.calls.some((c) => c.table === 'work_orders' && c.method === 'update')).toBe(false)
    expect(supabase.calls.some((c) => c.table === 'work_orders' && c.method === 'insert')).toBe(false)
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('creates the missing overdue WOs for a batch in ONE insert', async () => {
    const overdue = [
      overdueSchedule({ id: 'sched_a', property_id: 'prop_a' }),
      overdueSchedule({ id: 'sched_b', property_id: 'prop_b' }),
      overdueSchedule({ id: 'sched_c', property_id: 'prop_c' }),
    ]
    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: [], error: null },
        { data: overdue, error: null },
      ],
      work_orders: [
        { data: [], error: null },  // open-WO read — none open
        { data: [], error: null },  // existing (schedule, due date) pairs — none
        { data: [
          { id: 'wo_a', source_schedule_id: 'sched_a' },
          { id: 'wo_b', source_schedule_id: 'sched_b' },
          { id: 'wo_c', source_schedule_id: 'sched_c' },
        ], error: null },           // the single bulk insert
      ],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const inserts = supabase.calls.filter((c) => c.table === 'work_orders' && c.method === 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.args[0]).toHaveLength(3)
    expect(inserts[0]!.args[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_schedule_id: 'sched_a', priority: 'urgent', status: 'pending', scheduled_date: '2026-07-10' }),
      ]),
    )
    expect(logAuditEvents).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ action: 'work_order.created', targetId: 'wo_a', metadata: expect.objectContaining({ source: 'maintenance_schedule_overdue' }) }),
      ]),
    )
  })

  it('skips a schedule that already has a WO at that due date, without a per-schedule query', async () => {
    const overdue = [
      overdueSchedule({ id: 'sched_a', property_id: 'prop_a' }),
      overdueSchedule({ id: 'sched_b', property_id: 'prop_b' }),
    ]
    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: [], error: null },
        { data: overdue, error: null },
      ],
      work_orders: [
        { data: [], error: null },   // no open WOs (sched_a's is completed)
        { data: [{ source_schedule_id: 'sched_a', scheduled_date: '2026-07-10' }], error: null },
        { data: [{ id: 'wo_b', source_schedule_id: 'sched_b' }], error: null },
      ],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const inserts = supabase.calls.filter((c) => c.table === 'work_orders' && c.method === 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.args[0]).toEqual([expect.objectContaining({ source_schedule_id: 'sched_b' })])
  })

  it('re-reads and retries with the survivors when the bulk insert loses a create race', async () => {
    // A bulk INSERT here cannot use ON CONFLICT — wo_maintenance_schedule_date_unique
    // is a PARTIAL unique index and PostgREST cannot emit an index predicate, so
    // Postgres rejects the bare form with 42P10 (verified against the live
    // schema). That means ONE collision aborts the whole statement. Swallowing
    // the 23505 would silently drop every other schedule in the batch.
    const overdue = [
      overdueSchedule({ id: 'sched_a', property_id: 'prop_a' }),
      overdueSchedule({ id: 'sched_b', property_id: 'prop_b' }),
    ]
    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: [], error: null },
        { data: overdue, error: null },
      ],
      work_orders: [
        { data: [], error: null },                                  // no open WOs
        { data: [], error: null },                                  // pre-check: nothing exists yet
        { data: null, error: { code: '23505', message: 'duplicate key' } },  // sched_a lost the race
        { data: [{ source_schedule_id: 'sched_a', scheduled_date: '2026-07-10' }], error: null },  // re-read
        { data: [{ id: 'wo_b', source_schedule_id: 'sched_b' }], error: null },                    // survivor
      ],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const inserts = supabase.calls.filter((c) => c.table === 'work_orders' && c.method === 'insert')
    expect(inserts).toHaveLength(2)
    // The retry carries only the schedule that did NOT collide — the loser is
    // dropped because its work order now demonstrably exists.
    expect(inserts[1]!.args[0]).toEqual([expect.objectContaining({ source_schedule_id: 'sched_b' })])
    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({ action: 'work_order.created', targetId: 'wo_b' }),
    ])
  })

  it('throws rather than dropping the batch when the create race never resolves', async () => {
    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: [], error: null },
        { data: [overdueSchedule({ id: 'sched_a' })], error: null },
      ],
      work_orders: [
        { data: [], error: null },
        ...Array.from({ length: 3 }, () => [
          { data: [], error: null },
          { data: null, error: { code: '23505', message: 'duplicate key' } },
        ]).flat(),
      ],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })).rejects.toThrow(/lost the create race/)
  })

  it('spends one step per BATCH of overdue schedules, not one per schedule', async () => {
    // This is the whole finding. 250 overdue schedules used to mean 250
    // sequential Inngest steps and 500 work_orders round-trips in a single
    // invocation, every day — and the set does not self-clear, so it only ever
    // grows. At OVERDUE_BATCH_SIZE = 100 it is 3 steps.
    const overdue = Array.from({ length: 250 }, (_, i) =>
      overdueSchedule({ id: `sched_${i}`, property_id: `prop_${i}` }))

    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: [], error: null },
        { data: overdue, error: null },
      ],
      // Every schedule already has an urgent open WO → no writes at all, so the
      // only work_orders traffic is the one open-WO read per batch.
      work_orders: Array.from({ length: 3 }, (_, b) => ({
        data: overdue.slice(b * 100, b * 100 + 100).map((s) => ({
          id: `wo_${s.id}`, priority: 'urgent', status: 'in_progress', source_schedule_id: s.id,
        })),
        error: null,
      })),
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toMatchObject({ escalated: 250 })

    const overdueSteps = step.run.mock.calls.map((c) => c[0] as string).filter((n) => n.startsWith('escalate-overdue'))
    expect(overdueSteps).toEqual([
      'escalate-overdue-batch-0',
      'escalate-overdue-batch-1',
      'escalate-overdue-batch-2',
    ])

    // Three reads for 250 schedules, not 250.
    const woSelects = supabase.calls.filter((c) => c.table === 'work_orders' && c.method === 'select')
    expect(woSelects).toHaveLength(3)
  })

  it('reports and skips an overdue schedule with an invalid due date without failing the batch', async () => {
    const supabase = makeSupabase({
      maintenance_schedules: [
        { data: [], error: null },
        { data: [
          overdueSchedule({ id: 'sched_bad', next_due_date: 'not-a-date' }),
          overdueSchedule({ id: 'sched_ok' }),
        ], error: null },
      ],
      work_orders: [
        { data: [{ id: 'wo_ok', priority: 'urgent', status: 'pending', source_schedule_id: 'sched_ok' }], error: null },
      ],
      ...baseTables(),
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.maintenance-cron.invalid_due_date_overdue', orgId: 'org_1' }),
    )
    // The good schedule in the same batch was still processed.
    const openRead = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'in' && c.args[0] === 'source_schedule_id')
    expect(openRead?.args[1]).toEqual(['sched_ok'])
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

    const step = makeStep()
    const result = await invokeHandler(maintenanceSchedulesOrg, {
      event:  orgEvent(),
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toMatchObject({ checked: 2_100 })
    // Three pages requested for the due-schedule scan.
    const dueRanges = supabase.calls.filter((c) => c.table === 'maintenance_schedules' && c.method === 'range')
    expect(dueRanges.slice(0, 3).map((c) => c.args)).toEqual([[0, PAGE - 1], [PAGE, 2 * PAGE - 1], [2 * PAGE, 3 * PAGE - 1]])

    // ...and ZERO steps spent walking them. Reminder-only schedules do no work
    // in this pass at all — their PM-facing surface is cron-daily-wrapup — but
    // each used to cost a full Inngest step and state round-trip to reach the
    // `return`. 2,100 of them in one invocation is a step explosion producing
    // nothing, and it read as healthy because the assertion above (the only
    // one there was) is about the READ being complete.
    expect(step.run.mock.calls.map((c) => c[0]).filter((n) => String(n).startsWith('process-schedule-'))).toEqual([])
  })
})
