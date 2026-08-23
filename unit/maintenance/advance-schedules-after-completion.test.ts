import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { advanceSchedulesAfterCompletion } from '@/app/(dashboard)/maintenance/complete-work-order-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

// ============================================================================
// This function is the ONLY thing that moves a maintenance schedule forward
// after the work is done, and it had no direct tests at all.
//
// Its seasonal branch recorded last_completed_date and left next_due_date in
// the past — permanently, so completing a recurring schedule both hid the next
// occurrence from the PM and left the row eternally overdue. That is what made
// the daily overdue pass's work set grow monotonically for the life of an
// account.
//
// The seasonal representation itself is gone (20260823215150): an annually
// recurring schedule is routine + annual + a next_due_date on the month it
// recurs in. The DEFECT it protected against is not gone, so these tests moved
// to the annual path rather than being deleted with the column.
// ============================================================================

const NOW = new Date('2026-04-15T12:00:00.000Z')

function supabaseWith(schedules: Record<string, unknown>[]) {
  const spec: Record<string, TableSpec> = {
    maintenance_schedules: [
      { data: schedules, error: null },
      ...schedules.map(() => ({ data: null, error: null })),  // one write each
    ],
  }
  return createSupabaseDouble(spec)
}

function updatePayloads(supabase: ReturnType<typeof createSupabaseDouble>) {
  return supabase.calls
    .filter((c) => c.table === 'maintenance_schedules' && c.method === 'update')
    .map((c) => c.args[0] as Record<string, unknown>)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('advanceSchedulesAfterCompletion — annual, which is what seasonal became', () => {
  // The seasonal + month_due path is gone (20260823215150). What it expressed
  // — "this recurs every April" — is a routine schedule with frequency
  // 'annual' and a next_due_date in April, and calcNextDueDate preserves the
  // April anchor by stepping +12 months from the DUE date.
  //
  // ONE BEHAVIOURAL DIFFERENCE, stated rather than papered over. The seasonal
  // derivation always jumped to the next FUTURE occurrence, so a schedule six
  // years overdue landed on next April in one hop. The annual path steps one
  // interval from where it was, so six years overdue takes six completions to
  // catch up. That is deliberate: it is exactly how quarterly and monthly have
  // always behaved for the other 145 live schedules, it does not silently
  // erase missed occurrences, and the overdue pass is what surfaces the
  // backlog. Consistency with every other frequency beats a special case for
  // the one nobody used.

  it('rolls a completed annual schedule to the same month next year', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'routine', frequency: 'annual', next_due_date: '2026-04-01' },
    ])

    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    expect(updatePayloads(supabase)).toEqual([
      { last_completed_date: '2026-04-15', next_due_date: '2027-04-01' },
    ])
  })

  it('does not come back instantly overdue — the ratchet this all exists to stop', async () => {
    // The property the seasonal tests were really protecting: completing a
    // recurring schedule must move it into the future, or the daily overdue
    // pass re-walks it every day for the life of the account.
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'routine', frequency: 'annual', next_due_date: '2026-04-01' },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    const next = updatePayloads(supabase)[0]!['next_due_date'] as string
    expect(next > '2026-04-15').toBe(true)
  })

  it('anchors on the DUE date, not on when the work was finished', async () => {
    // Completed two weeks late, and the anchor holds: next April, not next
    // mid-April. This is the property that makes a stored anchor month
    // unnecessary in the first place.
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'routine', frequency: 'annual', next_due_date: '2026-04-01' },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    expect(updatePayloads(supabase)[0]!['next_due_date']).toBe('2027-04-01')
  })

  it('scopes the write to the org, not just the schedule id', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'routine', frequency: 'annual', next_due_date: '2026-04-01' },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    const updateIdx = supabase.calls.findIndex((c) => c.table === 'maintenance_schedules' && c.method === 'update')
    const after = supabase.calls.slice(updateIdx).filter((c) => c.method === 'eq')
    expect(after.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
  })

  it('records the completion date only for a schedule with nothing to recur into', async () => {
    // A row still carrying the retired `seasonal` type — nothing creates one
    // now, but the enum label remains and the broadcast path can still write a
    // schedule with no frequency. It must not invent a date.
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'seasonal', frequency: null, next_due_date: '2026-04-01' },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    expect(updatePayloads(supabase)).toEqual([{ last_completed_date: '2026-04-15' }])
  })
})

describe('advanceSchedulesAfterCompletion — the branches seasonal sits between', () => {
  it('still advances a routine schedule by its frequency, anchored to the scheduled date', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'routine', frequency: 'quarterly', next_due_date: '2026-03-01' },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    expect(updatePayloads(supabase)[0]).toMatchObject({ next_due_date: '2026-06-01' })
  })

  it('still anchors a gap-driven routine completion to the ACTUAL completion date', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'routine', frequency: 'quarterly', next_due_date: '2026-09-01' },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'vacancy_gap_suggestion' },
    ])

    // Done early during a vacancy gap → the cadence restarts from today.
    expect(updatePayloads(supabase)[0]).toMatchObject({ next_due_date: '2026-07-15' })
  })

  it('leaves a one-time schedule\'s next_due_date alone — retiring it is a product call', async () => {
    const supabase = supabaseWith([
      // `seasonal`, not `one_time`: the enum holds only routine|seasonal, so
      // one_time was never a storable value — the create form offered it and
      // the insert failed with 22P02. The option is gone (20260823215150).
      { id: 's1', schedule_type: 'seasonal', frequency: null, next_due_date: '2026-01-01' },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    expect(updatePayloads(supabase)).toEqual([{ last_completed_date: '2026-04-15' }])
  })

  it('writes nothing for a schedule that has no due date at all', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'seasonal', frequency: null, next_due_date: null },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    expect(updatePayloads(supabase)).toEqual([])
  })
})
