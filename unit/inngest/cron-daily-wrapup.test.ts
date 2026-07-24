import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn(async () => ({ data: { id: 'email_1' }, error: null })) } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/resend/emails/daily-wrapup', () => ({
  renderDailyWrapUpEmail: vi.fn(async () => '<html></html>'),
}))
// getPmEmails/diffDigestSnapshot are mocked directly (same convention as
// work-order-dispatch.test.ts mocking getPmMembers/createPmNotification)
// rather than simulated at the notification_digest_state/organization_members
// table level — this function's own direct queries (turnovers, properties,
// work_orders, etc.) are what's under test here.
vi.mock('@/lib/inngest/helpers', () => ({
  getPmEmails:        vi.fn(async () => []),
  diffDigestSnapshot:  vi.fn(async () => ({ newIds: [], unchangedIds: [], removedIds: [] })),
}))

import { dailyWrapUp, dailyWrapUpOrg } from '@/lib/inngest/functions/cron/daily-wrapup'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { renderDailyWrapUpEmail } from '@/lib/resend/emails/daily-wrapup'
import { getPmEmails } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and vendor-compliance-grace-check. Several tables (`turnovers`, `work_orders`)
// are queried twice per org run (tomorrow-section + unassigned-turnovers;
// unassigned-WOs + repeat-issue WOs) so a fixed per-table response isn't
// enough — order matters.
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
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sendEvent: vi.fn(async () => ({ ids: [] })),
  }
}

// 2026-07-22 is a Wednesday — neither the Friday-only asset-health section
// nor the Monday-only vacancy/full-resurface behavior applies, keeping the
// section set under test minimal and deterministic. The per-org handler
// derives all dates from event.data.now_ms, so the fixture pins it directly.
const NOW_MS = new Date('2026-07-22T23:00:00.000Z').getTime()

function wrapupEvent(orgId: string) {
  return { data: { org_id: orgId, now_ms: NOW_MS } }
}

// Every section other than the one under test in a given case resolves
// empty — this queues an empty response for every table the compute step
// queries (excluding the Friday-only/Monday-only sections, and excluding
// the second `notification_digest_state`-backed diffs since those are
// mocked out via lib/inngest/helpers above).
function emptyOrgTables() {
  return {
    turnovers:                  [{ data: [], error: null }, { data: [], error: null }],
    properties:                 [{ data: [], error: null }],
    vendor_compliance_documents: [{ data: [], error: null }],
    maintenance_schedules:      [{ data: [], error: null }],
    work_orders:                [{ data: [], error: null }, { data: [], error: null }],
    work_order_updates:         [{ data: [], error: null }],
    guidebook_configurations:   [{ data: null, error: null }],
    purchase_orders:            [{ data: [], error: null }],
  }
}

describe('dailyWrapUp (cron fan-out)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW_MS))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('dispatches no events when there are no active orgs with an invite-accepted PM', async () => {
    const supabase = makeSupabase({
      organization_members: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyWrapUp, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('fans out one org/daily_wrapup.requested event per distinct org, with a stable now_ms', async () => {
    const supabase = makeSupabase({
      organization_members: [{
        // org_1 appears twice (owner + admin) — must be deduped to one event
        data: [{ org_id: 'org_1' }, { org_id: 'org_1' }, { org_id: 'org_2' }],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyWrapUp, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 2 })
    expect(step.sendEvent).toHaveBeenCalledTimes(1)
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-daily-wrapups', [
      { name: 'org/daily_wrapup.requested', data: { org_id: 'org_1', now_ms: NOW_MS } },
      { name: 'org/daily_wrapup.requested', data: { org_id: 'org_2', now_ms: NOW_MS } },
    ])
    // The cron itself never computes sections or sends email — that's the
    // per-org handler's job.
    expect(resend.emails.send).not.toHaveBeenCalled()
  })
})

describe('dailyWrapUpOrg (per-org handler)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('sends no email when every digest section is empty', async () => {
    const supabase = makeSupabase(emptyOrgTables())
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(dailyWrapUpOrg, {
      event: wrapupEvent('org_1'),
      step:  makeStep(),
    })

    expect(result).toEqual({ orgId: 'org_1', sent: false, reason: 'nothing_to_report' })
    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(getPmEmails).not.toHaveBeenCalled() // hasContent short-circuits before the PM lookup
  })

  it('sends the wrap-up email with an idempotency key when at least one section has content', async () => {
    const supabase = makeSupabase({
      turnovers: [
        {
          data: [{
            id: 't1', checkout_datetime: '2026-07-23T15:00:00.000Z', status: 'assigned',
            properties: { name: 'Lakeview Cabin' },
            turnover_assignments: [{ crew_members: { name: 'Maria' } }],
          }],
          error: null,
        },
        { data: [], error: null }, // unassignedTurnovers — 2nd `turnovers` query
      ],
      properties:                  [{ data: [], error: null }],
      vendor_compliance_documents: [{ data: [], error: null }],
      maintenance_schedules:       [{ data: [], error: null }],
      work_orders:                 [{ data: [], error: null }, { data: [], error: null }],
      work_order_updates:          [{ data: [], error: null }],
      guidebook_configurations:    [{ data: null, error: null }],
      purchase_orders:             [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue(['pm@example.com'])

    const result = await invokeHandler(dailyWrapUpOrg, {
      event: wrapupEvent('org_1'),
      step:  makeStep(),
    })

    expect(result).toEqual({ orgId: 'org_1', sent: true })
    expect(renderDailyWrapUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        tomorrow: [{ property: 'Lakeview Cabin', time: expect.any(String), crew: 'Maria' }],
      }),
    )
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'pm@example.com', subject: expect.stringContaining('wrap-up') }),
      { idempotencyKey: 'daily-wrapup-org_1-2026-07-22' },
    )
    // No pending POs this run — the mark-as-sent update must not fire.
    const poUpdate = supabase.calls.find((c) => c.table === 'purchase_orders' && c.method === 'update')
    expect(poUpdate).toBeUndefined()
  })

  it('skips sending when the org has content but no PM email can be resolved', async () => {
    const supabase = makeSupabase({
      turnovers: [
        {
          data: [{
            id: 't1', checkout_datetime: '2026-07-23T15:00:00.000Z', status: 'assigned',
            properties: { name: 'Lakeview Cabin' },
            turnover_assignments: [],
          }],
          error: null,
        },
        { data: [], error: null },
      ],
      properties:                  [{ data: [], error: null }],
      vendor_compliance_documents: [{ data: [], error: null }],
      maintenance_schedules:       [{ data: [], error: null }],
      work_orders:                 [{ data: [], error: null }, { data: [], error: null }],
      work_order_updates:          [{ data: [], error: null }],
      guidebook_configurations:    [{ data: null, error: null }],
      purchase_orders:             [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await invokeHandler(dailyWrapUpOrg, {
      event: wrapupEvent('org_1'),
      step:  makeStep(),
    })

    expect(result).toEqual({ orgId: 'org_1', sent: false, reason: 'no_pm_email' })
    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('marks aggregated purchase orders as sent after a successful send', async () => {
    const supabase = makeSupabase({
      ...emptyOrgTables(),
      purchase_orders: [
        {
          data: [{
            id: 'po_1', property_id: 'prop_1',
            purchase_order_items: [{ item_name: 'Paper towels', quantity_to_buy: 4, unit: 'rolls' }],
            properties: { name: 'Lakeview Cabin' },
          }],
          error: null,
        },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue(['pm@example.com'])

    const result = await invokeHandler(dailyWrapUpOrg, {
      event: wrapupEvent('org_1'),
      step:  makeStep(),
    })

    expect(result).toEqual({ orgId: 'org_1', sent: true })
    expect(resend.emails.send).toHaveBeenCalledTimes(1)

    const poUpdate = supabase.calls.find((c) => c.table === 'purchase_orders' && c.method === 'update')
    expect(poUpdate?.args[0]).toEqual({ order_email_sent: true })
    const poIn = supabase.calls.find(
      (c) => c.table === 'purchase_orders' && c.method === 'in' && c.args[0] === 'id',
    )
    expect(poIn?.args[1]).toEqual(['po_1'])
  })
})
