/**
 * Trial timing, in one place.
 *
 * Before this, three things independently decided what a trial is:
 *
 *   - app/onboarding/actions.ts wrote `now + 14 days` inline at signup,
 *   - app/(dashboard)/layout.tsx re-derived "expired" from plan_status and
 *     trial_ends_at to decide whether to wall the account,
 *   - lib/inngest/functions/email-trial-lifecycle.tsx slept until
 *     `trialEnd - 3 days` to send the warning.
 *
 * Nothing held them together, and the warning threshold in particular is the
 * kind of number that gets changed in the email and nowhere else — leaving a
 * banner that promises more days than the account has.
 */

/** Length of the free trial granted at signup. */
export const TRIAL_DAYS = 14

/**
 * How many days out the "your trial is ending" warning starts.
 *
 * Matches the sleep in email-trial-lifecycle.tsx deliberately: the in-app
 * banner and the warning email should appear together, so a PM who ignores
 * one still sees the other on the same day rather than being surprised twice.
 */
export const TRIAL_WARNING_DAYS = 3

export interface TrialState {
  /** plan_status is 'trialing' AND the end date has not passed. */
  inTrial: boolean
  /** plan_status is 'trialing' AND the end date HAS passed — the billing gate. */
  expired: boolean
  /** Whole days remaining, floored at 0. Only meaningful when inTrial. */
  daysLeft: number
  /** Within the warning window — show the countdown. */
  showWarning: boolean
}

/**
 * Derive trial state from the two columns that describe it.
 *
 * `expired` is deliberately computed from the DATE rather than read from
 * plan_status, because plan_status is not reliable for this: production
 * currently holds four orgs still marked 'trialing' whose trial_ends_at
 * passed weeks ago. Nothing transitions that column when a trial lapses — the
 * gate has always been the live date comparison, and this preserves that
 * rather than "fixing" it into a stale-column read.
 */
export function trialState(
  planStatus: string | null | undefined,
  trialEndsAt: string | null | undefined,
  now: Date = new Date(),
): TrialState {
  const idle: TrialState = { inTrial: false, expired: false, daysLeft: 0, showWarning: false }

  if (planStatus !== 'trialing' || !trialEndsAt) return idle

  const endsAt = new Date(trialEndsAt).getTime()
  // An unparseable timestamp must not read as "expired" and wall a paying-ish
  // account, nor as "in trial" forever. Treat it as no trial at all and let
  // plan_status govern, which is the pre-existing behaviour for a null date.
  if (Number.isNaN(endsAt)) return idle

  const msLeft = endsAt - now.getTime()
  if (msLeft <= 0) return { inTrial: false, expired: true, daysLeft: 0, showWarning: false }

  // Ceil, not floor: with 18 hours left a PM should read "1 day", not "0 days
  // left" on an account that still works. The banner counts days they can
  // still use, and the last partial day is one of them.
  const daysLeft = Math.ceil(msLeft / 86_400_000)

  return {
    inTrial:     true,
    expired:     false,
    daysLeft,
    showWarning: daysLeft <= TRIAL_WARNING_DAYS,
  }
}
