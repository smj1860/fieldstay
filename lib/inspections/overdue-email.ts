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
  next_due_date:        string | null
  overdue_notified_for: string | null
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

/**
 * THREE DAYS, and the number is a judgment rather than a constant somebody
 * picked.
 *
 * A walk due today is not late today — somebody may be driving to it, and a
 * same-day email teaches the reader that this sender nags. Three days also
 * spans a weekend, which is the ordinary reason a Friday walk slips.
 *
 * The delay costs the record nothing: these schedules run annually or
 * semi-annually, so three days is under 1% of a cycle. And it is not the only
 * signal — the dashboard's Upcoming Inspections section styles the row as
 * overdue from day one, so the email is the escalation rather than the first
 * anyone hears of it.
 */
export const OVERDUE_EMAIL_DELAY_DAYS = 3

const DAY_MS = 86_400_000

/**
 * Schedules overdue by at least the delay whose current occurrence has not
 * already been mailed about.
 *
 * `IS DISTINCT FROM`, not `<`. An inspection completed late advances
 * next_due_date forward, but the vacancy nudge can also move a FUTURE due date
 * EARLIER to land it in a gap between bookings — and a `<` comparison would
 * read that as already-notified and swallow the next occurrence's email
 * entirely.
 */
export function selectOverdueForEmail<T extends OverdueCandidate>(
  candidates: readonly T[],
  today:      string,
  delayDays:  number = OVERDUE_EMAIL_DELAY_DAYS,
): OverdueSelection<T>[] {
  const cutoff = addDaysISO(today, -delayDays)

  return candidates
    .filter((c) => !!c.next_due_date
      && c.next_due_date <= cutoff
      && c.overdue_notified_for !== c.next_due_date)
    .map((c) => ({
      ...c,
      next_due_date: c.next_due_date as string,
      daysOverdue:   daysBetween(c.next_due_date as string, today),
    }))
    .sort((a, b) => a.next_due_date.localeCompare(b.next_due_date))
}

/**
 * ONE EMAIL PER ORG, NOT PER PROPERTY, and this is not a preference.
 *
 * `applySafetyTemplate` computes `firstSafetyDueDate` ONCE and writes it to
 * every property in the org, so a 29-property portfolio gets 29 schedules
 * sharing a single due date. They therefore cross the three-day line on the
 * same morning — and a per-property email would put 29 messages in one PM's
 * inbox before breakfast, on the first occurrence of a feature meant to build
 * trust.
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

function addDaysISO(date: string, days: number): string {
  return new Date(dayMs(date) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Midnight UTC for a `YYYY-MM-DD`, so a DST seam cannot shift the arithmetic. */
function dayMs(date: string): number {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  )
}
