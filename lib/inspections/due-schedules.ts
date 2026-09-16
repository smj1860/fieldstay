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
  /** Whole days until due; 0 when due today or overdue. Dashboard horizon only. */
  daysUntil:     number
}

const DAY_MS = 86_400_000

/**
 * Today as `YYYY-MM-DD` in the given IANA timezone — a due date is a local
 * day, but "the viewer's" is a lie the OLD signature told: `getTimezoneOffset()`
 * reflects the offset of the process EXECUTING the JS, not the browser that
 * will read the result. Called with no `timeZone` from a Next.js Server
 * Component (upcoming-for-dashboard.ts's default parameter) or an Inngest
 * cron (inspection-overdue-email.ts), that offset is Vercel's Lambda/Edge
 * runtime (UTC by default), not the PM's. A PM in Los Angeles viewing the
 * dashboard in the evening is, from the server's perspective, already into
 * "tomorrow" in UTC — a schedule due "today" per their own wall clock could
 * drop off the horizon list a day early or under-count daysLate by one.
 *
 * Defaults to UTC — an honest "the server's own day," not a stand-in for
 * "the viewer's". A caller that genuinely needs a specific viewer's local
 * day (inspections-view.tsx, client-side) must pass one explicitly; there is
 * no way to infer it server-side.
 */
export function todayISO(now: Date = new Date(), timeZone: string = 'UTC'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now) // en-CA formats as YYYY-MM-DD
}

/**
 * Schedule ids that already back an OPEN walk (started, not yet completed).
 *
 * Shared with lib/inspections/overdue-email.ts's selectOverdueForDigest for
 * the same reason selectDueSchedules delegates to selectUpcomingSchedules
 * rather than reimplementing the suppression rule: both surfaces answer "is
 * this schedule still waiting", and a second implementation would drift — the
 * monthly digest telling a PM a walk is overdue while someone is mid-walk on
 * it right now is exactly the kind of drift this prevents.
 */
export function scheduleIdsWithOpenWalk(
  inspections: readonly StartedInspectionInput[],
): ReadonlySet<string> {
  return new Set(
    inspections
      .filter((i) => !i.completed_at && i.source_schedule_id)
      .map((i) => i.source_schedule_id as string),
  )
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
  return selectUpcomingSchedules(schedules, inspections, today, 0)
}

/**
 * The same selection, widened to a horizon — what the dashboard's Upcoming
 * Inspections section shows (§9: "hidden until an inspection is within 30 days.
 * Overdue stays visible and is styled as overdue").
 *
 * `selectDueSchedules` DELEGATES to this rather than the two being written
 * separately, and that is deliberate. Both surfaces answer "what is due", and
 * the suppression rule below is subtle enough that a second implementation
 * would drift — at which point the dashboard would nag about a walk the
 * Maintenance page had already stopped listing, or the reverse. One rule, two
 * horizons.
 *
 * `horizonDays` is INCLUSIVE of the last day, so 29 matches the ops page's
 * existing `addDays(today, 29)` — a 30-day window counting today.
 */
export function selectUpcomingSchedules(
  schedules:   readonly DueScheduleInput[],
  inspections: readonly StartedInspectionInput[],
  today:       string,
  horizonDays: number,
): DueSchedule[] {
  const walkInProgress = scheduleIdsWithOpenWalk(inspections)

  const horizon = addDaysISO(today, horizonDays)

  return schedules
    .filter((s) => !!s.next_due_date && s.next_due_date <= horizon && !walkInProgress.has(s.id))
    .map((s) => ({
      ...s,
      next_due_date: s.next_due_date as string,
      overdue:       (s.next_due_date as string) < today,
      daysLate:      daysBetween(s.next_due_date as string, today),
      daysUntil:     daysBetween(today, s.next_due_date as string),
    }))
    .sort((a, b) => a.next_due_date.localeCompare(b.next_due_date))
}

/**
 * `YYYY-MM-DD` plus whole days, via UTC so no DST seam can shift the answer.
 * Exported for upcoming-for-dashboard.ts, which shares this exact date-math
 * contract — see selectUpcomingSchedules' header comment on why the
 * selection half is shared: a second implementation drifting from this one
 * would reintroduce the same class of "the dashboard nags about a walk the
 * Maintenance page already stopped listing" bug that design exists to prevent.
 */
export function addDaysISO(date: string, days: number): string {
  return new Date(dayMs(date) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Never negative here. */
function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((dayMs(to) - dayMs(from)) / DAY_MS))
}

/**
 * Midnight UTC for a `YYYY-MM-DD`, so the subtraction never crosses a DST seam.
 *
 * Belt-and-braces rather than load-bearing: `Math.round` in daysBetween already
 * absorbs a DST offset (a 29-day span reads as 29.0417 in local time and rounds
 * back to 29), and an offset would have to exceed 12 hours to survive that.
 * Stated because the DST test in due-schedules.test.ts cannot distinguish the
 * two, and an earlier version of it claimed otherwise.
 */
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

/**
 * The same label widened for the dashboard, where most rows are not yet due.
 *
 * Separate from `dueLabel` rather than replacing it: the Maintenance page's list
 * is only ever things due NOW, and "Due today" is the right words there. Widening
 * that function would have made every caller carry a horizon it does not have.
 */
export function upcomingLabel(schedule: Pick<DueSchedule, 'overdue' | 'daysLate' | 'daysUntil'>): string {
  if (schedule.overdue)          return dueLabel(schedule)
  if (schedule.daysUntil === 0)  return 'Due today'
  if (schedule.daysUntil === 1)  return 'Due tomorrow'
  return `Due in ${schedule.daysUntil} days`
}
