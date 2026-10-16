// lib/evidence/packet/deadlines.ts
//
// When a damage claim stops being fileable, and what to tell the PM about it.
// Pure: dates in, dates out. The Inngest function that notifies lives in
// lib/inngest/functions/evidence-deadlines.ts.
//
// ⚠️  THE PLATFORM RULES BELOW ARE POLICY, AND POLICY CHANGES. They were written
// from the owner's scope note (CLAUDE_EVIDENCE_3_SCOPE.md) and have NOT been
// verified against the platforms' current host terms. Verify before relying on
// a countdown, and change the constants here, nowhere else.
//
//   Airbnb: 14 days after checkout. A flat window: the next guest's check-in does
//           not shorten it (the owner confirmed 14 days is the correct countdown).
//   VRBO:   14 days after checkout (the scope note marks this "confirm").
//   Other:  no platform deadline; the org's own claim_window_days.
//
// All dates are YYYY-MM-DD strings compared as calendar dates in the PROPERTY's
// timezone, so a countdown does not flip a day early for a PM west of UTC.

export const AIRBNB_CLAIM_WINDOW_DAYS = 14
export const VRBO_CLAIM_WINDOW_DAYS   = 14

export type ClaimBasis =
  | 'airbnb_checkout_window'
  | 'vrbo_checkout_window'
  | 'org_claim_window'

export type ClaimStage = 'opened' | 'd7' | 'd2' | 'expired'

export interface ClaimDeadline {
  /** Last calendar day a claim can still be filed. */
  deadlineDate: string
  basis:        ClaimBasis
}

const DAY_MS = 86_400_000

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS)
}

export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10)
}

/** Whole calendar days from `today` to `date`. Negative once `date` has passed. */
export function daysBetween(today: string, date: string): number {
  return dayNumber(date) - dayNumber(today)
}

/** Today's calendar date in an IANA timezone, as YYYY-MM-DD. Falls back to UTC for a bad zone. */
export function localDate(nowMs: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(nowMs))
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10)
  }
}

export function claimDeadline(input: {
  source:           string | null
  checkoutDate:     string
  claimWindowDays:  number
}): ClaimDeadline {
  const { source, checkoutDate } = input

  if (source === 'airbnb') {
    return { deadlineDate: addDays(checkoutDate, AIRBNB_CLAIM_WINDOW_DAYS), basis: 'airbnb_checkout_window' }
  }

  if (source === 'vrbo') {
    return { deadlineDate: addDays(checkoutDate, VRBO_CLAIM_WINDOW_DAYS), basis: 'vrbo_checkout_window' }
  }

  return { deadlineDate: addDays(checkoutDate, input.claimWindowDays), basis: 'org_claim_window' }
}

/**
 * The single stage a stay is in today. A stay first seen late (already inside
 * the last two days) gets that stage only, never a backlog of earlier ones.
 */
export function stageFor(daysLeft: number): ClaimStage {
  if (daysLeft < 0) return 'expired'
  if (daysLeft <= 2) return 'd2'
  if (daysLeft <= 7) return 'd7'
  return 'opened'
}

export function deadlineDedupeKey(bookingId: string, stage: ClaimStage): string {
  return `evidence-deadline-${bookingId}-${stage}`
}

const BASIS_TEXT: Record<ClaimBasis, string> = {
  airbnb_checkout_window:     `${AIRBNB_CLAIM_WINDOW_DAYS} days after checkout`,
  vrbo_checkout_window:       `${VRBO_CLAIM_WINDOW_DAYS} days after checkout`,
  org_claim_window:           'your claim window after checkout',
}

export interface DeadlineNotice {
  title:    string
  subtitle: string
  severity: 'red' | 'amber' | 'blue'
}

/** Bell notification copy. No em dashes: a PM reads this. */
export function deadlineNotice(input: {
  stage:        ClaimStage
  propertyName: string | null
  deadlineDate: string
  daysLeft:     number
  basis:        ClaimBasis
}): DeadlineNotice {
  const where = input.propertyName ? ` at ${input.propertyName}` : ''
  const rule  = BASIS_TEXT[input.basis]
  const plural = input.daysLeft === 1 ? 'day' : 'days'

  switch (input.stage) {
    case 'expired':
      return {
        title:    `Claim window closed${where}`,
        subtitle: `The window to file a damage claim ended ${input.deadlineDate} (${rule}).`,
        severity: 'red',
      }
    case 'd2':
      return {
        title:    `Claim deadline in ${input.daysLeft} ${plural}${where}`,
        subtitle: `File by ${input.deadlineDate} (${rule}). Build the claim packet now.`,
        severity: 'red',
      }
    case 'd7':
      return {
        title:    `${input.daysLeft} days left to file a claim${where}`,
        subtitle: `File by ${input.deadlineDate} (${rule}).`,
        severity: 'amber',
      }
    default:
      return {
        title:    `Damage claim window open${where}`,
        subtitle: `File by ${input.deadlineDate} (${rule}). ${input.daysLeft} days left.`,
        severity: 'blue',
      }
  }
}
