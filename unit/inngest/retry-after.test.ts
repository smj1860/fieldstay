import { describe, it, expect } from 'vitest'
import { RetryAfterError } from 'inngest'

import { RateLimitError } from '@/lib/integrations/types'
import {
  rateLimitRetry,
  clampRetryAfterSeconds,
  MIN_RETRY_AFTER_SECONDS,
  MAX_RETRY_AFTER_SECONDS,
  FALLBACK_RETRY_AFTER_SECONDS,
} from '@/lib/inngest/retry-after'

// ============================================================================
// Regression cover for the 2026-09-06 Sentry triage.
//
// `fieldstay-hospitable-incremental-sync exhausted all retries: Rate limited —
// retry after 2s`: every Inngest call site that met a RateLimitError rethrew
// it as a plain Error, so Inngest applied a generic exponential backoff that
// knew nothing about the interval the provider had just supplied. The attempts
// after the first were spent re-asking too early, and the run dead-lettered.
// ============================================================================

describe('clampRetryAfterSeconds', () => {
  it('passes a sane interval through unchanged', () => {
    expect(clampRetryAfterSeconds(45)).toBe(45)
  })

  it('rounds a fractional interval UP, never down', () => {
    // Jittered backoffs (withRetryJitter) produce fractions. Rounding down
    // schedules the retry inside the window it was told to wait out.
    expect(clampRetryAfterSeconds(2.1)).toBe(3)
  })

  it('never schedules an immediate retry', () => {
    // A provider answering `Retry-After: 0`, or an in-app budget guard
    // computing a remaining window of zero, would otherwise ask for exactly
    // the retry storm this exists to stop.
    expect(clampRetryAfterSeconds(0)).toBe(MIN_RETRY_AFTER_SECONDS)
    expect(clampRetryAfterSeconds(-30)).toBe(MIN_RETRY_AFTER_SECONDS)
  })

  it('caps an absurd interval rather than parking the run for a day', () => {
    expect(clampRetryAfterSeconds(999_999)).toBe(MAX_RETRY_AFTER_SECONDS)
  })

  it('falls back when the interval is not a usable number', () => {
    // `Retry-After` given as an HTTP date parses to NaN. That NaN previously
    // reached RateLimitError (see hospitable.ts) and would reach
    // RetryAfterError's constructor here, which THROWS on a non-finite value
    // — turning a rate limit into a crash inside the rate-limit handler.
    expect(clampRetryAfterSeconds(Number.NaN)).toBe(FALLBACK_RETRY_AFTER_SECONDS)
    expect(clampRetryAfterSeconds(Number.POSITIVE_INFINITY)).toBe(FALLBACK_RETRY_AFTER_SECONDS)
  })
})

describe('rateLimitRetry', () => {
  it('produces an error Inngest schedules on, not just one it reads', () => {
    const err = rateLimitRetry(new RateLimitError(30))
    expect(err).toBeInstanceOf(RetryAfterError)
  })

  it('converts seconds to milliseconds', () => {
    // RateLimitError.retryAfter is SECONDS; RetryAfterError's numeric form is
    // MILLISECONDS. Passing it straight through asks for a 30ms wait on a 30s
    // rate limit — indistinguishable from a fix, and worse than the bug.
    expect(rateLimitRetry(new RateLimitError(30)).retryAfter).toBe('30')
  })

  it('keeps the original error as the cause', () => {
    const original = new RateLimitError(12)
    expect(rateLimitRetry(original).cause).toBe(original)
  })

  it('does not throw on a NaN interval', () => {
    expect(() => rateLimitRetry(new RateLimitError(Number.NaN))).not.toThrow()
    expect(rateLimitRetry(new RateLimitError(Number.NaN)).retryAfter)
      .toBe(String(FALLBACK_RETRY_AFTER_SECONDS))
  })
})
