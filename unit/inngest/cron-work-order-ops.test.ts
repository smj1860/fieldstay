import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent:  vi.fn(async () => undefined),
  logAuditEvents: vi.fn(async () => undefined),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(async () => undefined),
}))
vi.mock('@/lib/vendors/compliance', () => ({
  isVendorHardBlocked: vi.fn(async () => false),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { dailyWorkOrderOps, workOrderOpsOrg } from '@/lib/inngest/functions/cron/work-order-ops'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent, logAuditEvents } from '@/lib/audit'
import { createPmNotification } from '@/lib/inngest/helpers'
import { isVendorHardBlocked } from '@/lib/vendors/compliance'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

// Queue-based `.from(table)` mock — see unit/stubs/supabase-query-double.ts.
// `work_orders` is queried both for the aging pass and (per auto-created
// schedule) for the idempotency check + insert, so a fixed per-table
// response isn't enough.
function makeSupabase(queued: Record<string, TableSpec>) {
  return createSupabaseDouble(queued)
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

const NOW_MS = new Date('2026-07-22T13:00:00.000Z').getTime()

function orgEvent(orgId = 'org_1') {
  return { data: { org_id: orgId, now_ms: NOW_MS } }
}

describe('dailyWorkOrderOps (dispatcher)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW_MS))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('dispatches nothing when no org has aging work orders or due auto-WO schedules', async () => {
    const supabase = makeSupabase({
      work_orders:           [{ data: [], error: null }],
      maintenance_schedules: [{ data: [], error: null }],
      processed_webhooks:    [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyWorkOrderOps, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 0, webhook_inbox_cleaned: true })
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('fans out one org/work_order_ops.requested per org, unioning aging-WO and due-schedule orgs', async () => {
    const supabase = makeSupabase({
      work_orders:           [{ data: [{ org_id: 'org_1' }, { org_id: 'org_2' }], error: null }],
      maintenance_schedules: [{ data: [{ org_id: 'org_2' }, { org_id: 'org_3' }], error: null }],
      processed_webhooks:    [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyWorkOrderOps, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 3, webhook_inbox_cleaned: true })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-work-order-ops', [
      { name: 'org/work_order_ops.requested', data: { org_id: 'org_1', now_ms: NOW_MS } },
      { name: 'org/work_order_ops.requested', data: { org_id: 'org_2', now_ms: NOW_MS } },
      { name: 'org/work_order_ops.requested', data: { org_id: 'org_3', now_ms: NOW_MS } },
    ])
  })

  it('discovers orgs through paginated scans, so a >1000-row work order table still dispatches every tenant', async () => {
    const agingRows = Array.from({ length: 2_200 }, (_, i) => ({ org_id: `org_${i}` }))
    const supabase = makeSupabase({
      work_orders:           [{ data: agingRows, error: null }],
      maintenance_schedules: [{ data: [], error: null }],
      processed_webhooks:    [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyWorkOrderOps, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(result).toMatchObject({ dispatched: 2_200 })
    const fanOut = step.sendEvent.mock.calls.find((c) => c[0] === 'fan-out-work-order-ops')!
    const dispatchedOrgIds = (fanOut[1] as { data: { org_id: string } }[]).map((e) => e.data.org_id)
    expect(dispatchedOrgIds).toContain('org_2199')   // past PostgREST's 1000-row cap
  })

  it('deletes webhook inbox rows older than the 72h TTL in the dispatcher itself', async () => {
    const supabase = makeSupabase({
      work_orders:           [{ data: [], error: null }],
      maintenance_schedules: [{ data: [], error: null }],
      processed_webhooks:    [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(dailyWorkOrderOps, { event: {}, step: makeStep(), logger: makeLogger() })

    expect(supabase.calls.some((c) => c.table === 'processed_webhooks' && c.method === 'delete')).toBe(true)
    const ttlFilter = supabase.calls.find((c) => c.table === 'processed_webhooks' && c.method === 'lt')
    expect(ttlFilter?.args).toEqual([
      'processed_at',
      new Date(NOW_MS - 72 * 60 * 60 * 1000).toISOString(),
    ])
  })
})

describe('workOrderOpsOrg (per-org handler)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW_MS))
    ;(isVendorHardBlocked as ReturnType<typeof vi.fn>).mockResolvedValue(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('is a no-op when there are no aging work orders and no due auto-WO schedules', async () => {
    const supabase = makeSupabase({
      work_orders:           [{ data: [], error: null }],
      maintenance_schedules: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(workOrderOpsOrg, {
      event:  orgEvent(),
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ org_id: 'org_1', aging_escalated: 0, auto_wos_attempted: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('escalates a stale work order to urgent priority, logs it, and fires an aging-escalated event', async () => {
    const supabase = makeSupabase({
      work_orders: [
        {
          data: [{
            id: 'wo_1', org_id: 'org_1', property_id: 'prop_1',
            status: 'pending', created_at: '2026-07-10T00:00:00.000Z',
          }],
          error: null,
        },                                          // aging scan
        { data: [{ id: 'wo_1' }], error: null },    // optimistic-locked bulk update .select('id')
      ],
      work_order_updates:    [{ data: null, error: null }],
      maintenance_schedules: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(workOrderOpsOrg, {
      event:  orgEvent(),
      step,
      logger: makeLogger(),
    })

    expect((result as { aging_escalated: number }).aging_escalated).toBe(1)

    const updateCall = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'update')
    expect(updateCall?.args[0]).toEqual({ priority: 'urgent' })

    // Escalation is now batched: one audit write for the whole set, not one per WO.
    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        orgId:    'org_1',
        action:   'work_order.updated',
        targetId: 'wo_1',
        metadata: { change: 'auto_escalated_to_urgent' },
      }),
    ])

    expect(step.sendEvent).toHaveBeenCalledWith(
      'send-escalation-events',
      [expect.objectContaining({
        name: 'work-order/aging-escalated',
        data: expect.objectContaining({ work_order_id: 'wo_1', org_id: 'org_1', new_priority: 'urgent' }),
      })],
    )
  })

  it('writes no escalation notes when the optimistic-locked bulk update matched nothing (retry safety)', async () => {
    const supabase = makeSupabase({
      work_orders: [
        {
          data: [{
            id: 'wo_1', org_id: 'org_1', property_id: 'prop_1',
            status: 'pending', created_at: '2026-07-10T00:00:00.000Z',
          }],
          error: null,
        },
        { data: [], error: null },   // already urgent from a prior attempt — zero rows matched
      ],
      maintenance_schedules: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(workOrderOpsOrg, {
      event:  orgEvent(),
      step,
      logger: makeLogger(),
    })

    expect((result as { aging_escalated: number }).aging_escalated).toBe(0)
    expect(supabase.calls.some((c) => c.table === 'work_order_updates')).toBe(false)
    expect(logAuditEvents).not.toHaveBeenCalled()
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('auto-creates a work order for a due schedule, resolves a specialty-hint vendor, and notifies the PM', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: [], error: null },       // aging scan — none
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
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(workOrderOpsOrg, {
      event:  orgEvent(),
      step,
      logger: makeLogger(),
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

  it('creates the WO unassigned and requests a vendor suggestion when the resolved vendor is hard-blocked', async () => {
    ;(isVendorHardBlocked as ReturnType<typeof vi.fn>).mockResolvedValue(true)

    const supabase = makeSupabase({
      work_orders: [
        { data: [], error: null },   // aging scan — none
        { data: null, error: null }, // idempotency check
        { data: { id: 'wo_new' }, error: null },
      ],
      maintenance_schedules: [
        {
          data: [{
            id: 'sched_1', name: 'Quarterly HVAC service', org_id: 'org_1', property_id: 'prop_1',
            next_due_date: '2026-07-22', frequency: null, schedule_type: null,
            assigned_vendor_id: 'vendor_blocked', vendor_specialty_hint: 'hvac', estimated_cost: 200,
            instructions: 'Service the unit', properties: { name: 'Lakeview Cabin' },
          }],
          error: null,
        },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    await invokeHandler(workOrderOpsOrg, { event: orgEvent(), step, logger: makeLogger() })

    const insertCall = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'insert')
    expect(insertCall?.args[0]).toMatchObject({ vendor_id: null, category: 'hvac' })

    expect(step.sendEvent).toHaveBeenCalledWith(
      'send-vendor-suggestion-event-sched_1',
      expect.objectContaining({
        name: 'work-order/vendor-suggestion.requested',
        data: expect.objectContaining({ work_order_id: 'wo_new', org_id: 'org_1', category: 'hvac' }),
      }),
    )
  })

  // ── the next_due_date advance ───────────────────────────────────────────
  //
  // A silent failure here is permanent, not transient. next_due_date stays
  // put, so tomorrow the schedule looks due again, and the auto-create step's
  // (source_schedule_id, scheduled_date) unique constraint rejects the
  // duplicate as an expected race — so the schedule stops producing work
  // orders for this occurrence AND every future one, while the cron reports a
  // clean run every day.
  //
  // The same advance in app/(dashboard)/maintenance/actions.ts was already
  // bound and org-scoped; this copy was neither.
  it('throws when the next_due_date advance fails, rather than leaving the schedule stuck', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: [], error: null },                 // aging scan — none
        { data: null, error: null },               // idempotency check — none
        { data: { id: 'wo_new' }, error: null },   // the insert
      ],
      maintenance_schedules: [
        {
          data: [{
            id: 'sched_1', name: 'Quarterly HVAC service', org_id: 'org_1', property_id: 'prop_1',
            next_due_date: '2026-07-22', frequency: 'quarterly', schedule_type: 'routine',
            assigned_vendor_id: null, vendor_specialty_hint: null, estimated_cost: 200,
            instructions: 'Service the unit', properties: { name: 'Lakeview Cabin' },
          }],
          error: null,
        },
        { data: null, error: { message: 'deadlock detected', code: '40P01' } },  // the advance
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(workOrderOpsOrg, { event: orgEvent(), step: makeStep(), logger: makeLogger() })
    ).rejects.toThrow(/next_due_date advance failed/)
  })

  it('scopes the next_due_date advance to the org, not just the schedule id', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: [], error: null },
        { data: null, error: null },
        { data: { id: 'wo_new' }, error: null },
      ],
      maintenance_schedules: [
        {
          data: [{
            id: 'sched_1', name: 'Quarterly HVAC service', org_id: 'org_1', property_id: 'prop_1',
            next_due_date: '2026-07-22', frequency: 'quarterly', schedule_type: 'routine',
            assigned_vendor_id: null, vendor_specialty_hint: null, estimated_cost: 200,
            instructions: 'Service the unit', properties: { name: 'Lakeview Cabin' },
          }],
          error: null,
        },
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(workOrderOpsOrg, { event: orgEvent(), step: makeStep(), logger: makeLogger() })

    // Positional, not "org_id appears somewhere on this table": the
    // find-auto-wo-schedules read is also org-scoped, so a flat search passes
    // whether or not the UPDATE itself carries the filter. Anchor to the
    // update call and only look at the filters chained after it.
    const updateIdx = supabase.calls.findIndex(
      (c) => c.table === 'maintenance_schedules' && c.method === 'update'
    )
    expect(updateIdx).toBeGreaterThan(-1)

    const filtersAfterUpdate = supabase.calls
      .slice(updateIdx)
      .filter((c) => c.table === 'maintenance_schedules' && c.method === 'eq')

    expect(filtersAfterUpdate.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
  })

  it('skips auto-creating a work order when one already exists for the schedule + due date (idempotency)', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: [], error: null },                    // aging scan — none
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
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    await invokeHandler(workOrderOpsOrg, {
      event:  orgEvent(),
      step,
      logger: makeLogger(),
    })

    // No insert, no audit log, no notification, no event — the existing WO short-circuits everything.
    expect(supabase.calls.some((c) => c.table === 'work_orders' && c.method === 'insert')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(createPmNotification).not.toHaveBeenCalled()
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('escalates every aging work order in a >1000-row backlog, not just the first page', async () => {
    const aging = Array.from({ length: 2_050 }, (_, i) => ({
      id: `wo_${i}`, org_id: 'org_1', property_id: 'prop_1',
      status: 'pending', created_at: '2026-07-10T00:00:00.000Z',
    }))
    const supabase = makeSupabase({
      work_orders: [
        { data: aging, error: null },                                // paginated aging scan
        // The escalating UPDATE is CHUNKED (500), because `.select('id')` on an
        // UPDATE is a PostgREST response and max_rows caps its RETURNING too.
        // One seeded response per chunk, each returning only that chunk — which
        // is exactly what production returns now that no single call can exceed
        // the cap. Seeding one 2050-row response instead would model a
        // RETURNING clause that cannot exist.
        ...Array.from({ length: Math.ceil(aging.length / 500) }, (_, c) => ({
          data:  aging.slice(c * 500, (c + 1) * 500).map((w) => ({ id: w.id })),
          error: null,
        })),
      ],
      work_order_updates:    [{ data: null, error: null }],
      maintenance_schedules: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(workOrderOpsOrg, {
      event:  orgEvent(),
      step,
      logger: makeLogger(),
    })

    expect((result as { aging_escalated: number }).aging_escalated).toBe(2_050)
    const notesInsert = supabase.calls.find((c) => c.table === 'work_order_updates' && c.method === 'insert')
    expect((notesInsert?.args[0] as unknown[]).length).toBe(2_050)
    expect(step.sendEvent.mock.calls[0]![1]).toHaveLength(2_050)
  })
})
