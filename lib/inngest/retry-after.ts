// lib/inngest/retry-after.ts
// ============================================================================
// Turn a provider's RateLimitError into a retry Inngest will actually WAIT for.
//
// ── The defect this closes ──────────────────────────────────────────────────
//
// A RateLimitError carries the provider's own Retry-After in `retryAfter`
// seconds. Every Inngest call site that met one rethrew it as a plain Error
// with a comment saying "so Inngest retries with backoff" — and Inngest did,
// on its own generic exponential schedule, which knows nothing about the
// number the provider just told us. The first retry therefore lands whenever
// Inngest feels like it rather than when the budget window rolls, and against
// a short window it lands too early, fails again, and eats the retry budget.
//
// That is not hypothetical: `fieldstay-hospitable-incremental-sync exhausted
// all retries: Rate limited — retry after 2s` (Sentry, 2026-08-17). Every
// attempt after the first was spent re-asking an API that had already said
// how long to wait, and the run then dead-lettered — which, for a function in
// on-failure.ts's CRITICAL_FUNCTION_IDS, also pages the founder.
//
// Inngest's own RetryAfterError is the mechanism for this: it schedules the
// next attempt at the time we name, instead of the time the backoff curve
// picks. Nothing else about the retry contract changes — the attempt budget,
// the dead-letter, the on-failure handler are all as before.
// ============================================================================

import { RetryAfterError } from 'inngest'

import type { RateLimitError } from '@/lib/integrations/types'

/**
 * Never schedule the next attempt sooner than this. A provider that answers
 * `Retry-After: 0` (or a proactive in-app budget guard that computes a
 * remaining window of zero) would otherwise ask for an immediate retry, which
 * is the retry storm this module exists to stop.
 */
export const MIN_RETRY_AFTER_SECONDS = 1

/**
 * Never schedule it later than this. A malformed or absurd Retry-After must
 * not park a run for hours — past an hour the next scheduled tick of the
 * dispatching cron is the better recovery path than a single held retry.
 */
export const MAX_RETRY_AFTER_SECONDS = 3_600

/**
 * Used when `retryAfter` is not a usable number at all (NaN from a
 * `Retry-After` given as an HTTP date, Infinity, a negative). One minute is
 * the conventional cool-off across every adapter in `lib/integrations/
 * providers/*` and matches what they already fall back to in-band.
 */
export const FALLBACK_RETRY_AFTER_SECONDS = 60

/** Clamp a provider-supplied Retry-After into a schedulable number of seconds. */
export function clampRetryAfterSeconds(raw: number): number {
  if (!Number.isFinite(raw)) return FALLBACK_RETRY_AFTER_SECONDS
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil(raw)))
}

/**
 * The error to throw INSTEAD of rethrowing a RateLimitError from inside an
 * Inngest function (whether at the top level or inside a `step.run` body).
 *
 * The original is kept as `cause` so the provider's own wording, and the
 * `RateLimitError` type itself, survive into the serialized failure rather
 * than being flattened into a sentence.
 *
 * ⚠️ RetryAfterError's numeric form is MILLISECONDS, while RateLimitError's
 * `retryAfter` is SECONDS. Passing the seconds straight through would ask for
 * a 2ms wait on a 2s rate limit — a retry storm dressed as a fix — so the
 * conversion lives here rather than at each call site.
 */
export function rateLimitRetry(err: RateLimitError): RetryAfterError {
  const seconds = clampRetryAfterSeconds(err.retryAfter)
  return new RetryAfterError(err.message, seconds * 1_000, { cause: err })
}
