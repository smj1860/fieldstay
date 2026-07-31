import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn() } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmEmails:          vi.fn(),
  createPmNotification: vi.fn(),
}))
vi.mock('@/lib/resend/emails/pm-alert', () => ({
  renderPmAlert: vi.fn(async () => '<html>pm-alert</html>'),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/observability/metrics', () => ({
  incrementCounter: vi.fn(),
}))

import { handleTurnoverCreated, handleTurnoverCompleted } from '@/lib/inngest/functions/turnover-events'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { invokeHandler } from './test-helpers'

// Fixed canned response per table — turnovers and properties are each
// fetched exactly once (inside a single Promise.all), so no queueing is
// needed here, matching the pattern in work-order-crew-completed.test.ts.
function makeSupabase(perTable: Record<string, { data?: unknown; error?: unknown }>) {
  const from = vi.fn((table: string) => {
    const result = perTable[table] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.single = vi.fn(() => Promise.resolve(result))
    return chain
  })
  return { from }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const baseEvent = {
  turnover_id:       'to_1',
  property_id:       'prop_1',
  org_id:            'org_1',
  checkout_datetime: '2026-07-25T16:00:00Z',
  checkin_datetime:  '2026-07-25T20:00:00Z',
  window_minutes:    240,
}

const baseProperty = { name: 'The Lakehouse', city: 'Austin', state: 'TX', timezone: 'America/Chicago' }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
})

describe('handleTurnoverCreated', () => {
  it('returns warned:false and sends no email when no crew is assigned yet', async () => {
    const supabase = makeSupabase({
      turnovers: {
        data: {
          id: 'to_1', checkout_datetime: baseEvent.checkout_datetime, checkin_datetime: baseEvent.checkin_datetime,
          window_minutes: 240, status: 'pending_assignment', priority: 'medium',
          turnover_assignments: [],
        },
        error: null,
      },
      properties: { data: baseProperty, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleTurnoverCreated, {
      event: { data: baseEvent },
      step:  runAllStep(),
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(result).toEqual({ turnover_id: 'to_1', warned: false })
  })

  it('emails each assigned crew member with an idempotency key and reports crewNotified', async () => {
    const supabase = makeSupabase({
      turnovers: {
        data: {
          id: 'to_1', checkout_datetime: baseEvent.checkout_datetime, checkin_datetime: baseEvent.checkin_datetime,
          window_minutes: 240, status: 'assigned', priority: 'high',
          turnover_assignments: [
            { crew_member_id: 'crew_1', crew_members: { name: 'Maria', email: 'maria@example.com', phone: '555-1111', preferred_contact: 'email' } },
          ],
        },
        error: null,
      },
      properties: { data: baseProperty, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleTurnoverCreated, {
      event: { data: baseEvent },
      step:  runAllStep(),
    })

    expect(resend.emails.send).toHaveBeenCalledTimes(1)
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'maria@example.com' }),
      { idempotencyKey: 'turnover-assigned-to_1-crew_1' },
    )
    expect(result).toEqual({ turnover_id: 'to_1', crewNotified: 1 })
  })

  it('skips the email for an assigned crew member with no email on file, but still counts them as notified', async () => {
    const supabase = makeSupabase({
      turnovers: {
        data: {
          id: 'to_1', checkout_datetime: baseEvent.checkout_datetime, checkin_datetime: baseEvent.checkin_datetime,
          window_minutes: 240, status: 'assigned', priority: 'medium',
          turnover_assignments: [
            { crew_member_id: 'crew_2', crew_members: { name: 'Bob', email: null, phone: '555-2222', preferred_contact: 'sms' } },
          ],
        },
        error: null,
      },
      properties: { data: baseProperty, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleTurnoverCreated, {
      event: { data: baseEvent },
      step:  runAllStep(),
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(result).toEqual({ turnover_id: 'to_1', crewNotified: 1 })
  })

  it('returns undefined and sends nothing when the turnover or property lookup misses', async () => {
    const supabase = makeSupabase({
      turnovers:  { data: null, error: null },
      properties: { data: baseProperty, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleTurnoverCreated, {
      event: { data: baseEvent },
      step:  runAllStep(),
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })
})

describe('handleTurnoverCompleted — record-crew-duration', () => {
  // handleTurnoverCompleted has several unrelated steps (PM notifications,
  // milestone recording, cleaning-fee posting) that would need their own
  // mock data to run without erroring. This isolates just the
  // record-crew-duration step, matching the "only run the named step"
  // pattern rather than stubbing out five unrelated steps' queries.
  // handleTurnoverCompleted's own return value is always {turnover_id,
  // notified: true} regardless of what any individual step returned — so
  // to assert on record-crew-duration's own result, capture what its
  // step.run callback resolved to rather than reading invokeHandler's
  // return value.
  function onlyRecordCrewDurationStep() {
    const captured: { value?: unknown } = {}
    const step = {
      run: vi.fn((name: string, cb: () => unknown) => {
        if (name !== 'record-crew-duration') return undefined
        return Promise.resolve(cb()).then((v) => {
          captured.value = v
          return v
        })
      }),
    }
    return { step, captured }
  }

  function makeLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
  }

  // Builds a from() mock for exactly the tables/queries record-crew-duration
  // touches. `turnovers` is queried twice (a select, then later an update)
  // — dispatched by call order since that matches the step's actual
  // control flow (read before write).
  function makeSupabase(opts: {
    checklistInstance?:  { data: unknown; error?: unknown }
    checklistItems?:     { data: unknown; error?: unknown }
    turnoverRow?:        { data: unknown; error?: unknown }
    lastInventoryEdit?:  { data: unknown; error?: unknown }
    assignmentOutcomesUpdated?: { data: unknown; error?: unknown }
  }) {
    let turnoverCallCount = 0
    const assignmentOutcomesUpdate = vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() => Promise.resolve(opts.assignmentOutcomesUpdated ?? { data: [{ id: 'ao_1' }], error: null })),
        })),
      })),
    }))
    const turnoverUpdate = vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })) }))

    const from = vi.fn((table: string) => {
      if (table === 'checklist_instances') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve(opts.checklistInstance ?? { data: null, error: null })) })) })) })) }
      }
      if (table === 'checklist_instance_items') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ not: vi.fn(() => Promise.resolve(opts.checklistItems ?? { data: [], error: null })) })) })) }
      }
      if (table === 'inventory_items') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ gt: vi.fn(() => ({ order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve(opts.lastInventoryEdit ?? { data: null, error: null })) })) })) })) })) })) }
      }
      if (table === 'assignment_outcomes') {
        return { update: assignmentOutcomesUpdate }
      }
      if (table === 'turnovers') {
        turnoverCallCount += 1
        if (turnoverCallCount === 1) {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve(opts.turnoverRow ?? { data: null, error: null })) })) })) })) }
        }
        return { update: turnoverUpdate }
      }
      throw new Error(`Unexpected table in test: ${table}`)
    })

    return { from, assignmentOutcomesUpdate, turnoverUpdate }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips when there is no checklist instance and no inventory activity', async () => {
    const supabase = makeSupabase({
      checklistInstance: { data: null, error: null },
      turnoverRow:        { data: { property_id: 'prop_1', inventory_started_at: null, inventory_confirmed_complete_at: null }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const { step, captured } = onlyRecordCrewDurationStep()

    await invokeHandler(handleTurnoverCompleted, {
      event:  { data: baseEvent },
      step,
      logger: makeLogger(),
    })

    expect(captured.value).toEqual({ skipped: 'no_completion_signals' })
    expect(supabase.assignmentOutcomesUpdate).not.toHaveBeenCalled()
    expect(supabase.turnoverUpdate).not.toHaveBeenCalled()
  })

  it('computes duration from checklist items alone (MAX - MIN of completed_at)', async () => {
    const supabase = makeSupabase({
      checklistInstance: { data: { id: 'inst_1' }, error: null },
      checklistItems: {
        data: [
          { completed_at: '2026-07-25T10:00:00.000Z' },
          { completed_at: '2026-07-25T10:20:00.000Z' },
          { completed_at: '2026-07-25T10:45:00.000Z' },
        ],
        error: null,
      },
      turnoverRow: { data: { property_id: 'prop_1', inventory_started_at: null, inventory_confirmed_complete_at: null }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const { step, captured } = onlyRecordCrewDurationStep()

    await invokeHandler(handleTurnoverCompleted, {
      event:  { data: baseEvent },
      step,
      logger: makeLogger(),
    })

    expect(captured.value).toEqual({ updated_rows: 1, duration_minutes: 45 })
    expect(supabase.assignmentOutcomesUpdate).toHaveBeenCalledWith({
      started_at:   '2026-07-25T10:00:00.000Z',
      completed_at: '2026-07-25T10:45:00.000Z',
      duration_minutes: 45,
    })
    expect(supabase.turnoverUpdate).toHaveBeenCalledWith({ crew_duration_minutes: 45 })
  })

  it('folds in inventory_confirmed_complete_at as an additional completion signal', async () => {
    const supabase = makeSupabase({
      checklistInstance: { data: { id: 'inst_1' }, error: null },
      checklistItems: {
        data: [{ completed_at: '2026-07-25T10:00:00.000Z' }],
        error: null,
      },
      turnoverRow: {
        data: { property_id: 'prop_1', inventory_started_at: '2026-07-25T09:50:00.000Z', inventory_confirmed_complete_at: '2026-07-25T11:00:00.000Z' },
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const { step, captured } = onlyRecordCrewDurationStep()

    await invokeHandler(handleTurnoverCompleted, {
      event:  { data: baseEvent },
      step,
      logger: makeLogger(),
    })

    // Earliest signal is the checklist item (10:00), latest is the
    // inventory confirmation (11:00) — inventory_started_at itself (9:50)
    // must NOT be a candidate, only completion-type signals are.
    expect(captured.value).toEqual({ updated_rows: 1, duration_minutes: 60 })
  })

  it('falls back to the last inventory item edit when Confirm Inventory Complete was never pressed', async () => {
    const supabase = makeSupabase({
      checklistInstance: { data: { id: 'inst_1' }, error: null },
      checklistItems: {
        data: [{ completed_at: '2026-07-25T10:00:00.000Z' }],
        error: null,
      },
      turnoverRow: {
        data: { property_id: 'prop_1', inventory_started_at: '2026-07-25T09:50:00.000Z', inventory_confirmed_complete_at: null },
        error: null,
      },
      lastInventoryEdit: { data: { updated_at: '2026-07-25T10:30:00.000Z' }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const { step, captured } = onlyRecordCrewDurationStep()

    await invokeHandler(handleTurnoverCompleted, {
      event:  { data: baseEvent },
      step,
      logger: makeLogger(),
    })

    expect(captured.value).toEqual({ updated_rows: 1, duration_minutes: 30 })
  })

  it('does not query inventory_items when inventory was never touched (inventory_started_at is null)', async () => {
    const supabase = makeSupabase({
      checklistInstance: { data: { id: 'inst_1' }, error: null },
      checklistItems: {
        data: [{ completed_at: '2026-07-25T10:00:00.000Z' }, { completed_at: '2026-07-25T10:10:00.000Z' }],
        error: null,
      },
      turnoverRow: { data: { property_id: 'prop_1', inventory_started_at: null, inventory_confirmed_complete_at: null }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const { step, captured } = onlyRecordCrewDurationStep()

    await invokeHandler(handleTurnoverCompleted, {
      event:  { data: baseEvent },
      step,
      logger: makeLogger(),
    })

    expect(captured.value).toEqual({ updated_rows: 1, duration_minutes: 10 })
    expect(supabase.from).not.toHaveBeenCalledWith('inventory_items')
  })

  it('skips and logs a warning instead of recording an implausibly long duration', async () => {
    const supabase = makeSupabase({
      checklistInstance: { data: { id: 'inst_1' }, error: null },
      checklistItems: {
        data: [
          { completed_at: '2026-07-20T10:00:00.000Z' },
          { completed_at: '2026-07-25T10:00:00.000Z' },
        ],
        error: null,
      },
      turnoverRow: { data: { property_id: 'prop_1', inventory_started_at: null, inventory_confirmed_complete_at: null }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const logger = makeLogger()
    const { step, captured } = onlyRecordCrewDurationStep()

    await invokeHandler(handleTurnoverCompleted, {
      event: { data: baseEvent },
      step,
      logger,
    })

    expect(captured.value).toEqual(expect.objectContaining({ skipped: 'anomalous_duration' }))
    expect(logger.warn).toHaveBeenCalled()
    expect(supabase.assignmentOutcomesUpdate).not.toHaveBeenCalled()
    expect(supabase.turnoverUpdate).not.toHaveBeenCalled()
  })
})
