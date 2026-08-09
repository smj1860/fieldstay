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
// the past — permanently. A seasonal schedule is recurring by definition
// (month_due exists for nothing else), so completing one both hid next year's
// occurrence from the PM and left the row eternally overdue, which is what
// made the daily overdue pass's work set grow monotonically for the life of
// an account.
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

describe('advanceSchedulesAfterCompletion — seasonal', () => {
  it('rolls a completed seasonal schedule to NEXT year\'s month_due', async () => {
    // Completed in April, due every April → next April, not this one. Rolling
    // to the same year's month would put next_due_date on or before today and
    // leave the schedule instantly overdue again.
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'seasonal', frequency: null, next_due_date: '2026-04-01', month_due: 4 },
    ])

    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    expect(updatePayloads(supabase)).toEqual([
      { last_completed_date: '2026-04-15', next_due_date: '2027-04-01' },
    ])
  })

  it('rolls to THIS year when the due month is still ahead', async () => {
    // Completed in April, due every October → October of the same year.
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'seasonal', frequency: null, next_due_date: '2025-10-01', month_due: 10 },
    ])

    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    expect(updatePayloads(supabase)[0]).toMatchObject({ next_due_date: '2026-10-01' })
  })

  it('never leaves the new due date in the past, whatever the month', async () => {
    // The property that matters: a seasonal schedule that comes back overdue
    // the moment it is completed is the ratchet this fixes. Sweep all twelve.
    for (let month = 1; month <= 12; month++) {
      const supabase = supabaseWith([
        { id: 's1', schedule_type: 'seasonal', frequency: null, next_due_date: '2020-01-01', month_due: month },
      ])
      await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
        { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
      ])
      const next = updatePayloads(supabase)[0]!['next_due_date'] as string
      expect(next > '2026-04-15', `month_due=${month} produced ${next}, on or before today`).toBe(true)
    }
  })

  it('scopes the write to the org, not just the schedule id', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'seasonal', frequency: null, next_due_date: '2026-04-01', month_due: 4 },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    const updateIdx = supabase.calls.findIndex((c) => c.table === 'maintenance_schedules' && c.method === 'update')
    const after = supabase.calls.slice(updateIdx).filter((c) => c.method === 'eq')
    expect(after.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
  })

  it('records the completion date only for a seasonal schedule with no month to recur into', async () => {
    // resolveFirstDueDate calls this state "genuinely underspecified" and
    // refuses to invent a date at creation; the completion path must not
    // invent one either.
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'seasonal', frequency: null, next_due_date: '2026-04-01', month_due: null },
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
      { id: 's1', schedule_type: 'routine', frequency: 'quarterly', next_due_date: '2026-03-01', month_due: null },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    expect(updatePayloads(supabase)[0]).toMatchObject({ next_due_date: '2026-06-01' })
  })

  it('still anchors a gap-driven routine completion to the ACTUAL completion date', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'routine', frequency: 'quarterly', next_due_date: '2026-09-01', month_due: null },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'vacancy_gap_suggestion' },
    ])

    // Done early during a vacancy gap → the cadence restarts from today.
    expect(updatePayloads(supabase)[0]).toMatchObject({ next_due_date: '2026-07-15' })
  })

  it('leaves a one-time schedule\'s next_due_date alone — retiring it is a product call', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'one_time', frequency: null, next_due_date: '2026-01-01', month_due: null },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    expect(updatePayloads(supabase)).toEqual([{ last_completed_date: '2026-04-15' }])
  })

  it('writes nothing for a schedule that has no due date at all', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'seasonal', frequency: null, next_due_date: null, month_due: 4 },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    expect(updatePayloads(supabase)).toEqual([])
  })
})
