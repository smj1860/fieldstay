// Which overdue inspections earn an email, and what it says.
//
// §9's overdue email, and §2's "Email the assignee" as amended on 2026-08-24:
// it goes to the PM / org owner. Every safety schedule the onboarding template
// generates is deliberately unassigned (`assigned_to_user_id: null` in
// apply-safety-template.ts — guessing an assignee would notify somebody who
// never agreed to walk 29 properties), so "the assignee" had nobody to resolve
// to in the case that will make up nearly all of them.
//
// Pure and dependency-free so the two decisions that matter — WHEN, and WHO
// GETS BUNDLED — are testable without a database or a mail transport.

/** The fields the selector needs. A structural subset of MaintenanceSchedule. */
export interface OverdueCandidate {
  id:                   string
  org_id:               string
  property_id:          string
  next_due_date:          string | null
  overdue_notified_month: string | null
}

/**
 * A selected row, preserving whatever else the caller read.
 *
 * Generic rather than fixed to `OverdueCandidate`: the cron also needs the
 * schedule name and the property embed to build the email, and a non-generic
 * return type silently erased both — the rows still carried the fields at
 * runtime, so the loss showed up only as a type error at the far end rather
 * than as anything visible here.
 */
export type OverdueSelection<T extends OverdueCandidate = OverdueCandidate> = T & {
  next_due_date: string
  daysOverdue:   number
}

const DAY_MS = 86_400_000

/**
 * A MONTHLY DIGEST, sent on the 1st, covering everything still outstanding.
 *
 * The earlier rule was "three days after the due date", which reads as the
 * gentler option and is not, because inspection due dates cluster by MONTH
 * rather than by day:
 *
 *   applySafetyTemplate seeds every property with the 1st of the template's
 *   month — literally the same date for all of them — and from the second
 *   occurrence onward nudgeDueDateIntoVacancy moves each to a different day
 *   inside roughly that month, picked from that property's own booking gaps.
 *
 * So a per-due-date rule produces one email per distinct gap, trickling across
 * the month: 29 on a single morning for a portfolio's first occurrence, then
 * a scatter of ones and twos for every occurrence after. One email on the 1st
 * covering the month just ended is a digest instead of a drip.
 *
 * THE COST, STATED: a walk missed on the 2nd waits until the 1st of the next
 * month to be emailed about — roughly four weeks. That is accepted rather than
 * overlooked. The dashboard's Upcoming Inspections section styles the row as
 * overdue from day one, so the email is the escalation and not the first anyone
 * hears of it, and an annual schedule is not made materially worse by four
 * weeks. If that tail ever proves too long, the fix is a second earlier nudge,
 * not abandoning the digest.
 */
export function selectOverdueForDigest<T extends OverdueCandidate>(
  candidates:  readonly T[],
  runDate:     string,
): OverdueSelection<T>[] {
  const monthStart = firstOfMonth(runDate)

  return candidates
    .filter((c) => !!c.next_due_date
      // Due in a PRIOR month. A walk due later this month is not overdue, and
      // one due earlier today is this month's business, not last month's.
      && c.next_due_date < monthStart
      // Reported in an EARLIER digest, not this one. A schedule that stays
      // overdue reappears next month by design — the month changes, so the
      // comparison stops matching. That is what makes this a digest rather
      // than a single notice that goes quiet while the problem persists.
      && c.overdue_notified_month !== monthStart)
    .map((c) => ({
      ...c,
      next_due_date: c.next_due_date as string,
      daysOverdue:   daysBetween(c.next_due_date as string, runDate),
    }))
    .sort((a, b) => a.next_due_date.localeCompare(b.next_due_date))
}

/** `YYYY-MM-01` for the month `date` falls in. The digest's identity. */
export function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/**
 * ONE EMAIL PER ORG.
 *
 * Grouping is stable (orgs in first-seen order, schedules already sorted by due
 * date) so a run is reproducible and a test can assert on it.
 */
export function groupByOrg<T extends OverdueCandidate>(
  selected: readonly OverdueSelection<T>[],
): Map<string, OverdueSelection<T>[]> {
  const byOrg = new Map<string, OverdueSelection<T>[]>()
  for (const row of selected) {
    const existing = byOrg.get(row.org_id)
    if (existing) existing.push(row)
    else byOrg.set(row.org_id, [row])
  }
  return byOrg
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((dayMs(to) - dayMs(from)) / DAY_MS))
}

/** Midnight UTC for a `YYYY-MM-DD`, so a DST seam cannot shift the arithmetic. */
function dayMs(date: string): number {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  )
}
