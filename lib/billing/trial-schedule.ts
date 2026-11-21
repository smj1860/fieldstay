/**
 * When the trial emails fall, as pure functions of a trial end date, and how to
 * tell that the end date has MOVED.
 *
 * Why this exists: the trial lifecycle sequence (email-trial-lifecycle.tsx) is
 * started once, with `trial_ends_at` copied into the event, and then sleeps for
 * up to two weeks. The in-app gate (lib/billing/trial.ts) reads the LIVE column,
 * so an extension takes effect in the app at once while the sequence still
 * planned its emails around the old date: "Your FieldStay trial has ended" would
 * arrive on the old end date to someone who was just given another week, followed
 * three days later by "I'm truly sorry FieldStay wasn't the right fit".
 *
 * The sequence now re-reads the live date each time it wakes and re-plans when
 * it has moved later. Pure and dependency-free so it can be tested without
 * Inngest, and so the offsets live in one place beside TRIAL_WARNING_DAYS.
 */
import { TRIAL_WARNING_DAYS } from '@/lib/billing/trial'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** The "ends in 3 days" email goes out this long before the trial ends. */
export function trialWarningAt(trialEnd: Date): Date {
  return new Date(trialEnd.getTime() - TRIAL_WARNING_DAYS * DAY_MS)
}

/** "Your trial has ended" goes out shortly AFTER the end, never before it. */
export function trialExpiredEmailAt(trialEnd: Date): Date {
  return new Date(trialEnd.getTime() + 2 * HOUR_MS)
}

/**
 * Differences smaller than this are noise (a re-saved timestamp, millisecond
 * rounding between Stripe seconds and a Postgres timestamptz), not an extension.
 */
const EXTENSION_TOLERANCE_MS = 60 * 1000

/**
 * The live trial end if it is LATER than the one the sequence planned around,
 * otherwise null.
 *
 * Only a later date counts. A trial shortened on purpose is already honoured by
 * the in-app gate and by hasLeftTrial; re-planning earlier would mean waking a
 * sequence in the past and sending the expiry email to someone mid-conversation.
 * An unreadable or missing date is "no extension" for the same reason: the safe
 * default is to carry on as planned, never to invent a date.
 */
export function extendedTrialEnd(planned: Date, liveTrialEndsAt: string | null | undefined): Date | null {
  if (!liveTrialEndsAt) return null
  const live = new Date(liveTrialEndsAt)
  if (Number.isNaN(live.getTime())) return null
  return live.getTime() - planned.getTime() > EXTENSION_TOLERANCE_MS ? live : null
}

/**
 * Round 0 keeps the ORIGINAL Inngest step ids and Resend idempotency keys
 * byte for byte, because sequences already sleeping were started under them and
 * a renamed step is a step that never matches its recorded history. Rounds after
 * an extension get a suffix so the new emails are not swallowed by round 0's
 * keys (the 3-day warning for the NEW date must be able to send).
 */
export function roundSuffix(round: number): string {
  return round === 0 ? '' : `-r${round}`
}

/**
 * How many times one run will re-plan. Extensions are a manual, occasional act,
 * so this is generous; it exists so a bug that keeps moving the date cannot make
 * one run schedule steps without end.
 */
export const MAX_TRIAL_EXTENSIONS = 5
