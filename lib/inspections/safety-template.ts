// The org's safety-inspection template, and the date it produces.
//
// §2 of INSPECTIONS_SPEC: inspection frequency is set in onboarding. Safety is
// the only form that belongs there, because it is the only one that runs at
// EVERY property — indoor and outdoor are per-property decisions set up as
// ordinary recurring maintenance (a lakefront house with a dock and a studio
// condo do not want the same walk).
//
// A TEMPLATE HAS NO DUE DATE. It carries a month and a cadence, which is the
// rule that produces `next_due_date` for each property's schedule. That
// distinction is the whole reason a month here is not `month_due` coming back:
// that column sat on the SCHEDULE alongside `next_due_date` and could disagree
// with it.
//
// Pure and dependency-free, so both appliers — the onboarding fan-out and the
// nightly backfill — compute the same date from the same rule.

/** The two cadences a safety walk may run at. See the CHECK in 20260824091200. */
export type SafetyFrequency = 'semi_annual' | 'annual'

export interface SafetyTemplate {
  frequency:  SafetyFrequency
  /** 1–12. The month the cycle starts in. */
  startMonth: number
}

/**
 * Reads the template off an organizations row, or null when it has not been set.
 *
 * Both-or-neither is enforced by `organizations_safety_template_complete`, so a
 * half-answered template cannot reach here — but this still checks both, because
 * a type coming out of PostgREST is a claim and the constraint is the proof.
 */
export function readSafetyTemplate(org: {
  inspection_safety_frequency:   string | null
  inspection_safety_start_month: number | null
}): SafetyTemplate | null {
  const { inspection_safety_frequency: freq, inspection_safety_start_month: month } = org
  if (freq !== 'semi_annual' && freq !== 'annual') return null
  if (month === null || month < 1 || month > 12) return null
  return { frequency: freq, startMonth: month }
}

/** The months a template runs in, ascending. Two for semi-annual, one for annual. */
export function templateMonths(template: SafetyTemplate): number[] {
  if (template.frequency === 'annual') return [template.startMonth]
  // +6, wrapped. `((m + 5) % 12) + 1` keeps it in 1–12 without a branch:
  // March (3) pairs with September (9), October (10) with April (4).
  const second = ((template.startMonth + 5) % 12) + 1
  return [template.startMonth, second].sort((a, b) => a - b)
}

/**
 * The first `next_due_date` a property's schedule should carry.
 *
 * The 1st of the next month the template runs in, counting from `today` —
 * INCLUSIVE, so a template set up in March with a March start is due this
 * month rather than next year. That is what a PM answering "March" on the
 * onboarding step means, and making them wait eleven months for the first walk
 * would be a strange reading of it.
 *
 * THE 1st, DELIBERATELY, AND ONLY FOR THE FIRST OCCURRENCE. The template names
 * a month and nothing finer, so there is no better day to pick. Every
 * SUBSEQUENT occurrence is moved onto a day the property is actually empty
 * (`nudgeDueDateIntoVacancy`, on advance) — that needs the property's bookings,
 * which is a query per property and not worth running 29 times inside an
 * onboarding submit for a date the PM can move by hand.
 */
export function firstSafetyDueDate(template: SafetyTemplate, today: Date): string {
  const months = templateMonths(template)
  const year   = today.getUTCFullYear()
  const month  = today.getUTCMonth() + 1

  const thisYear = months.find((m) => m >= month)
  if (thisYear !== undefined) return isoFirstOfMonth(year, thisYear)

  // Every run month is behind us — the cycle resumes at the earliest one next
  // year. `months` is ascending, so that is months[0].
  return isoFirstOfMonth(year + 1, months[0]!)
}

/**
 * Where an EXISTING schedule's due date moves to when the template changes.
 *
 * Different question to `firstSafetyDueDate`, and the difference is one that
 * matters. That one counts from today's MONTH inclusive, which is right for a
 * property being scheduled for the first time — a PM answering "March" in March
 * means this March. Re-basing an existing schedule that way can land the date
 * in the PAST: today is the 20th, the template says March, and the schedule
 * would come back already overdue for a walk nobody was told about.
 *
 * So this counts from today's DATE, and returns the first run-month 1st that
 * has not already gone by.
 */
export function rebasedSafetyDueDate(template: SafetyTemplate, today: Date): string {
  const todayIso = today.toISOString().slice(0, 10)
  const year     = today.getUTCFullYear()

  // Two years of candidates: a December template re-based on December 2nd has
  // no remaining date this year, and its next is January.
  const candidates = [year, year + 1]
    .flatMap((y) => templateMonths(template).map((m) => isoFirstOfMonth(y, m)))
    .sort((a, b) => a.localeCompare(b))

  return candidates.find((d) => d >= todayIso) ?? candidates[candidates.length - 1]!
}

function isoFirstOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/** "Twice a year — March and September". The whole sentence, so no caller builds one. */
export function describeSafetyTemplate(template: SafetyTemplate): string {
  const names = templateMonths(template).map((m) => MONTH_NAMES[m - 1])
  const cadence = template.frequency === 'annual' ? 'Once a year' : 'Twice a year'
  return `${cadence} — ${names.join(' and ')}`
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const
