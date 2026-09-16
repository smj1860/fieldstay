import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { advanceSchedulesAfterCompletion } from '@/app/(dashboard)/maintenance/complete-work-order-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'
import { reportError } from '@/lib/observability/report-error'

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
//
// SCALABILITY FIX (20260916120000): the per-schedule .update() fan-out is
// gone, replaced by ONE bulk_advance_maintenance_schedules RPC call carrying
// every schedule's update in a single p_updates array. These tests now read
// that array off supabase.rpc's recorded call instead of one .update() call
// per schedule.
// ============================================================================

const NOW = new Date('2026-04-15T12:00:00.000Z')

interface ScheduleUpdate {
  id: string
  last_completed_date: string
  next_due_date: string | null
}

function supabaseWith(
  schedules: Record<string, unknown>[],
  rpcResult: { data?: unknown; error?: unknown } = { data: schedules.length, error: null },
) {
  const spec: Record<string, TableSpec> = {
    maintenance_schedules: [{ data: schedules, error: null }],
  }
  return createSupabaseDouble(spec, { rpc: rpcResult })
}

/** The p_updates array from the single bulk_advance_maintenance_schedules call. */
function rpcUpdates(supabase: ReturnType<typeof createSupabaseDouble>): ScheduleUpdate[] {
  const call = supabase.rpc.mock.calls.find((c) => c[0] === 'bulk_advance_maintenance_schedules')
  if (!call) return []
  return (call[1] as { p_updates: ScheduleUpdate[] }).p_updates
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('advanceSchedulesAfterCompletion — one bulk RPC call, not one per schedule', () => {
  it('sends every schedule in ONE rpc call, scoped to the org', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'routine', frequency: 'quarterly', next_due_date: '2026-03-01' },
      { id: 's2', schedule_type: 'routine', frequency: 'monthly',   next_due_date: '2026-04-01' },
    ])

    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
      { scheduleId: 's2', workOrderSource: 'maintenance_schedule' },
    ])

    const rpcCalls = supabase.rpc.mock.calls.filter((c) => c[0] === 'bulk_advance_maintenance_schedules')
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]![1]).toMatchObject({ p_org_id: 'org_1' })
    expect(rpcUpdates(supabase).map((u) => u.id).sort()).toEqual(['s1', 's2'])
  })
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

    expect(rpcUpdates(supabase)).toEqual([
      { id: 's1', last_completed_date: '2026-04-15', next_due_date: '2027-04-01' },
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

    const next = rpcUpdates(supabase)[0]!.next_due_date!
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

    expect(rpcUpdates(supabase)[0]!.next_due_date).toBe('2027-04-01')
  })

  it('scopes the write to the org via p_org_id, not just the schedule id', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'routine', frequency: 'annual', next_due_date: '2026-04-01' },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    const rpcCall = supabase.rpc.mock.calls.find((c) => c[0] === 'bulk_advance_maintenance_schedules')
    expect(rpcCall![1]).toMatchObject({ p_org_id: 'org_1' })
  })

  it('records the completion date only for a schedule with nothing to recur into, leaving next_due_date null', async () => {
    // A row still carrying the retired `seasonal` type — nothing creates one
    // now, but the enum label remains and the broadcast path can still write a
    // schedule with no frequency. It must not invent a date.
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'seasonal', frequency: null, next_due_date: '2026-04-01' },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    // next_due_date is sent as null — the RPC's own COALESCE is what keeps
    // this from clobbering the stored value, not the JS side.
    expect(rpcUpdates(supabase)).toEqual([
      { id: 's1', last_completed_date: '2026-04-15', next_due_date: null },
    ])
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

    expect(rpcUpdates(supabase)[0]).toMatchObject({ next_due_date: '2026-06-01' })
  })

  it('still anchors a gap-driven routine completion to the ACTUAL completion date', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'routine', frequency: 'quarterly', next_due_date: '2026-09-01' },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'vacancy_gap_suggestion' },
    ])

    // Done early during a vacancy gap → the cadence restarts from today.
    expect(rpcUpdates(supabase)[0]).toMatchObject({ next_due_date: '2026-07-15' })
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

    expect(rpcUpdates(supabase)).toEqual([
      { id: 's1', last_completed_date: '2026-04-15', next_due_date: null },
    ])
  })

  it('writes nothing for a schedule that has no due date at all', async () => {
    const supabase = supabaseWith([
      { id: 's1', schedule_type: 'seasonal', frequency: null, next_due_date: null },
    ])
    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    // Nothing to advance at all — the RPC is never even called.
    expect(supabase.rpc.mock.calls.filter((c) => c[0] === 'bulk_advance_maintenance_schedules')).toEqual([])
  })
})

describe('advanceSchedulesAfterCompletion — bulk RPC failure is reported, never thrown', () => {
  // The old Promise.allSettled isolated one rejecting write from the others.
  // With one set-based RPC call there is exactly one outcome to report
  // instead of up to N of them — this is the new failure mode, and it must
  // still never throw out of this function (finalizeWorkOrderCompletion's
  // whole contract depends on that).
  it('reports a resolved RPC error and does not throw', async () => {
    const supabase = supabaseWith(
      [{ id: 's1', schedule_type: 'routine', frequency: 'quarterly', next_due_date: '2026-03-01' }],
      { data: null, error: { message: 'permission denied' } },
    )

    await expect(
      advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
        { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
      ]),
    ).resolves.toBeUndefined()

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'permission denied' }),
      expect.objectContaining({ site: 'maintenance.advanceSchedulesAfterCompletion.write' }),
    )
  })

  it('reports a genuinely REJECTING rpc call (a network-level throw) and does not throw', async () => {
    const spec: Record<string, TableSpec> = {
      maintenance_schedules: [
        { data: [{ id: 's1', schedule_type: 'routine', frequency: 'quarterly', next_due_date: '2026-03-01' }], error: null },
      ],
    }
    const supabase = createSupabaseDouble(spec, {
      rpc: () => Promise.reject(new Error('network blip')),
    })

    await expect(
      advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
        { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
      ]),
    ).resolves.toBeUndefined()

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'maintenance.advanceSchedulesAfterCompletion.write' }),
    )
  })

  it('warns (does not error) when the RPC applies fewer rows than requested', async () => {
    const supabase = supabaseWith(
      [{ id: 's1', schedule_type: 'routine', frequency: 'quarterly', next_due_date: '2026-03-01' }],
      { data: 0, error: null },
    )

    await advanceSchedulesAfterCompletion(supabase as never, 'org_1', [
      { scheduleId: 's1', workOrderSource: 'maintenance_schedule' },
    ])

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'maintenance.advanceSchedulesAfterCompletion.write', level: 'warning' }),
    )
  })
})
