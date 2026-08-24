import { describe, it, expect } from 'vitest'
import {
  dueLabel,
  selectDueSchedules,
  todayISO,
  type DueScheduleInput,
  type StartedInspectionInput,
} from '@/lib/inspections/due-schedules'

// ============================================================================
// WHAT IS DUE — §7's list, and the one suppression that keeps it honest.
//
// An inspection schedule NOTIFIES when it comes due and creates nothing, so the
// only thing that turns a due schedule into a walk is a PM tapping Start. That
// makes this list the entire mechanism, and it has to be computable on a device
// with no signal against tables it already holds.
// ============================================================================

const TODAY = '2026-09-15'

const schedule = (over: Partial<DueScheduleInput> = {}): DueScheduleInput => ({
  id:                 'sched-1',
  property_id:        'prop-1',
  name:               'Quarterly safety walk',
  next_due_date:      TODAY,
  inspection_form_id: 'form-safety',
  ...over,
})

const inspection = (over: Partial<StartedInspectionInput> = {}): StartedInspectionInput => ({
  source_schedule_id: null,
  completed_at:       null,
  ...over,
})

describe('selectDueSchedules', () => {
  it('includes a schedule due exactly today, not marked overdue', () => {
    const [due] = selectDueSchedules([schedule()], [], TODAY)
    expect(due).toMatchObject({ id: 'sched-1', overdue: false, daysLate: 0 })
  })

  it('includes an overdue one and counts the days', () => {
    const [due] = selectDueSchedules([schedule({ next_due_date: '2026-09-12' })], [], TODAY)
    expect(due).toMatchObject({ overdue: true, daysLate: 3 })
  })

  it('excludes one that is not due yet', () => {
    expect(selectDueSchedules([schedule({ next_due_date: '2026-09-16' })], [], TODAY)).toEqual([])
  })

  it('excludes a dormant schedule with no next_due_date', () => {
    // resolveFirstDueDate leaves a row in this state when it cannot derive a
    // first occurrence. Treating null as due would put a walk with no date on
    // the queue and claim it was late.
    expect(selectDueSchedules([schedule({ next_due_date: null })], [], TODAY)).toEqual([])
  })

  it('SUPPRESSES one whose walk is already in progress', () => {
    // The load-bearing case. A schedule advances only at COMPLETION, so between
    // starting the walk and signing it off its next_due_date still reads as
    // due. Left in the list, the PM taps Start on a job they are halfway
    // through and gets a SECOND inspection against one occurrence — two
    // reports, and whichever finishes last advances the schedule while the
    // other is orphaned.
    const started = [inspection({ source_schedule_id: 'sched-1' })]
    expect(selectDueSchedules([schedule()], started, TODAY)).toEqual([])
  })

  it('does NOT suppress when the prior walk is COMPLETE', () => {
    // Completion advances the schedule past today, so a row still showing as
    // due after one is a genuinely new occurrence — an annual walk done last
    // year, most often.
    const done = [inspection({ source_schedule_id: 'sched-1', completed_at: '2025-09-15T12:00:00Z' })]
    expect(selectDueSchedules([schedule()], done, TODAY)).toHaveLength(1)
  })

  it('an open walk on a DIFFERENT schedule suppresses nothing', () => {
    const other = [inspection({ source_schedule_id: 'sched-2' })]
    expect(selectDueSchedules([schedule()], other, TODAY)).toHaveLength(1)
  })

  it('an ad-hoc walk — no source schedule — suppresses nothing', () => {
    // Most inspections are ad-hoc. Documents the intent rather than guarding
    // it: a null in the suppression set cannot collide with a real schedule id,
    // so the `&& i.source_schedule_id` filter is inert defensive typing and
    // deleting it changes no behaviour. Kept because the next person to touch
    // that filter should see the case spelled out.
    expect(selectDueSchedules([schedule()], [inspection()], TODAY)).toHaveLength(1)
  })

  it('sorts most overdue first — this is a work queue, not a calendar', () => {
    const rows = selectDueSchedules(
      [
        schedule({ id: 'today',   next_due_date: TODAY }),
        schedule({ id: 'ancient', next_due_date: '2026-06-01' }),
        schedule({ id: 'recent',  next_due_date: '2026-09-10' }),
      ],
      [], TODAY,
    )
    expect(rows.map((r) => r.id)).toEqual(['ancient', 'recent', 'today'])
  })

  it('counts days across a month boundary and a DST seam', () => {
    // The arithmetic is in UTC precisely so a local-time subtraction cannot
    // return 2.958 days and round to 3 in one half of the year and 2 in the
    // other. 2026-10-25 is the EU DST change.
    const [due] = selectDueSchedules([schedule({ next_due_date: '2026-10-24' })], [], '2026-11-02')
    expect(due!.daysLate).toBe(9)
  })
})

/**
 * A Date that reports a timezone offset of our choosing.
 *
 * `todayISO` reads exactly two things — `getTime()` and `getTimezoneOffset()` —
 * so this is enough, and it is the only way to test the distinction that
 * matters: CI runs in UTC, where `getTimezoneOffset()` is 0 and the correct
 * implementation and a bare `toISOString().slice(0,10)` produce identical
 * output for every input. A test written against the real Date in this
 * environment passes whether the correction is there or not.
 */
function dateInZone(utcIso: string, offsetMinutes: number): Date {
  const real = new Date(utcIso)
  return Object.assign(Object.create(Date.prototype) as Date, {
    getTime:            () => real.getTime(),
    getTimezoneOffset:  () => offsetMinutes,
  })
}

describe('todayISO', () => {
  it('is the LOCAL calendar day west of Greenwich, not the UTC one', () => {
    // 04:30Z on the 16th is 23:30 on the 15th in Chicago — and the evening is
    // exactly when a PM plans tomorrow. The UTC reading would show a walk as
    // due a day early, every evening.
    expect(todayISO(dateInZone('2026-09-16T04:30:00Z', 300))).toBe('2026-09-15')
  })

  it('and east of it, where the error runs the other way', () => {
    // 23:30Z on the 15th is 00:30 on the 16th in Berlin. Same defect, opposite
    // sign: the UTC reading would keep yesterday's walk on the queue.
    expect(todayISO(dateInZone('2026-09-15T23:30:00Z', -60))).toBe('2026-09-16')
  })
})

describe('dueLabel', () => {
  it('reads as a status, and singularises', () => {
    expect(dueLabel({ overdue: false, daysLate: 0 })).toBe('Due today')
    expect(dueLabel({ overdue: true,  daysLate: 1 })).toBe('1 day overdue')
    expect(dueLabel({ overdue: true,  daysLate: 4 })).toBe('4 days overdue')
  })
})
