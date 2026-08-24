// Which inspection schedules are due, and which already have a walk.
//
// §7: an inspection schedule NOTIFIES when it comes due and creates nothing —
// a row minted by a cron would claim the walk started at 08:00 UTC, and the
// report presents that duration as evidence. So the only thing that turns a due
// schedule into an inspection is a PM tapping Start, which makes "what is due"
// a list somebody has to be shown.
//
// Pure and dependency-free: the inputs are the two tables the device already
// caches, and the answer has to be computable at a property with no signal.

/** The fields this selector needs. A structural subset of MaintenanceSchedule. */
export interface DueScheduleInput {
  id:                 string
  property_id:        string
  name:               string
  next_due_date:      string | null
  inspection_form_id: string | null
}

/** The fields this selector needs from a cached inspection. */
export interface StartedInspectionInput {
  source_schedule_id: string | null
  completed_at:       string | null
}

export interface DueSchedule extends DueScheduleInput {
  next_due_date: string
  /** Strictly before today. Drives the amber/red distinction, nothing else. */
  overdue:       boolean
  /** Whole days late; 0 when it is due exactly today. */
  daysLate:      number
}

const DAY_MS = 86_400_000

/** Today as `YYYY-MM-DD` in the VIEWER's timezone — a due date is a local day. */
export function todayISO(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

/**
 * Active inspection schedules that are due on or before `today` and do not
 * already have a walk under way.
 *
 * SUPPRESSING THE ONE THAT ALREADY HAS AN OPEN INSPECTION IS THE LOAD-BEARING
 * PART. A schedule only advances at COMPLETION (advanceSourceSchedule), so
 * between starting the walk and signing it off its `next_due_date` still reads
 * as due. Left in the list, the PM sees "Start" on a job they are halfway
 * through and taps it, which creates a SECOND inspection against one occurrence
 * — two reports, and whichever finishes last advances the schedule while the
 * other is orphaned. The in-progress walk is already listed below as itself.
 *
 * A COMPLETED inspection does not suppress. Completion advances the schedule
 * past today, so a row still showing as due after one is a genuinely new
 * occurrence — most often an annual schedule whose walk was done last year.
 *
 * A schedule with no `next_due_date` is not due. That is the dormant state
 * `resolveFirstDueDate` leaves a row in when it cannot derive a first
 * occurrence, and the UI flags it as unscheduled elsewhere rather than
 * pretending a date.
 *
 * Sorted most-overdue first: the list is a work queue, not a calendar.
 */
export function selectDueSchedules(
  schedules:   readonly DueScheduleInput[],
  inspections: readonly StartedInspectionInput[],
  today:       string,
): DueSchedule[] {
  const walkInProgress = new Set(
    inspections
      .filter((i) => !i.completed_at && i.source_schedule_id)
      .map((i) => i.source_schedule_id as string),
  )

  return schedules
    .filter((s) => !!s.next_due_date && s.next_due_date <= today && !walkInProgress.has(s.id))
    .map((s) => ({
      ...s,
      next_due_date: s.next_due_date as string,
      overdue:       (s.next_due_date as string) < today,
      daysLate:      daysBetween(s.next_due_date as string, today),
    }))
    .sort((a, b) => a.next_due_date.localeCompare(b.next_due_date))
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Never negative here. */
function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((dayMs(to) - dayMs(from)) / DAY_MS))
}

/** Midnight UTC for a `YYYY-MM-DD`, so the subtraction never crosses a DST seam. */
function dayMs(date: string): number {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  )
}

/** "Due today" / "3 days overdue" — the whole label, so callers never build one. */
export function dueLabel(schedule: Pick<DueSchedule, 'overdue' | 'daysLate'>): string {
  if (!schedule.overdue) return 'Due today'
  return schedule.daysLate === 1 ? '1 day overdue' : `${schedule.daysLate} days overdue`
}
