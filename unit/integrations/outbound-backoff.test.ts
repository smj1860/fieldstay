import { describe, it, expect, vi, afterEach } from 'vitest'

// ============================================================================
// The two backoff primitives every outbound provider budget now shares.
//
// Both encode a defect found on 2026-08-17 while diagnosing the Hospitable
// incremental-sync retry storm:
//
//   - outboundBackoffSeconds: checkLimit() sets `reset` to Date.now() when the
//     limiter THREW, so the obvious `ceil((reset - now) / 1000)` floors to 1
//     second. Three of the four outbound budgets computed exactly that, which
//     means a Redis outage produced a ~1s retry loop against a third-party API
//     — and a fabricated retry-after that reads in logs like a real provider
//     signal. Only krogerFetch handled it; its fix is now the shared one.
//
//   - parseRetryAfterSeconds: RFC 7231 permits Retry-After as delay-seconds OR
//     an HTTP-date. A bare parseInt() on the date form yields NaN, which
//     reached RateLimitError's message as "retry after NaNs" and would reach
//     step.sleep() as the duration string `NaNs` — an unparseable duration
//     turning a routine throttle into a hard function failure.
// ============================================================================

import { outboundBackoffSeconds, ERRORED_BUDGET_BACKOFF_SECONDS, type LimitDecision } from '@/lib/rate-limit'
import { parseRetryAfterSeconds } from '@/lib/integrations/providers/hospitable'

afterEach(() => { vi.useRealTimers() })

function decision(over: Partial<LimitDecision>): LimitDecision {
  return {
    allowed: false, skipped: false, errored: false,
    limit: 54, remaining: 0, reset: Date.now(),
    ...over,
  }
}

describe('outboundBackoffSeconds', () => {
  it('backs off a full minute when the limiter itself errored', () => {
    // The regression. `reset` is Date.now() here — meaningless, because no
    // window was ever read. Deriving a wait from it gives ~1s.
    const seconds = outboundBackoffSeconds(decision({ errored: true, reset: Date.now() }), { jitter: false })

    expect(seconds).toBe(ERRORED_BUDGET_BACKOFF_SECONDS)
    expect(seconds).toBeGreaterThan(1)
  })

  it('uses the real remaining window when the budget is genuinely exhausted', () => {
    // The non-errored case must NOT be flattened to the 60s fallback — an
    // exhausted window knows exactly when it reopens.
    const seconds = outboundBackoffSeconds(
      decision({ errored: false, reset: Date.now() + 12_000 }),
      { jitter: false },
    )

    expect(seconds).toBe(12)
  })

  it('jitters by default, within 1.0x-1.5x, and never below the base', () => {
    // Jitter exists so callers blocked by ONE shared window do not all
    // re-enter the budget on the same tick. Asserted as a range over many
    // samples rather than a fixed value, since the whole point is variation.
    const samples = Array.from({ length: 200 }, () =>
      outboundBackoffSeconds(decision({ errored: false, reset: Date.now() + 20_000 })),
    )

    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(20)
      expect(s).toBeLessThanOrEqual(30)
    }
    expect(new Set(samples).size).toBeGreaterThan(1)
  })

  it('never returns a non-positive wait', () => {
    // A window that has already reset would otherwise yield 0 or negative,
    // and a 0s backoff is an immediate retry by another name.
    expect(outboundBackoffSeconds(decision({ reset: Date.now() - 30_000 }), { jitter: false })).toBeGreaterThanOrEqual(1)
  })
})

describe('parseRetryAfterSeconds', () => {
  it('reads the delay-seconds form', () => {
    // '2' is the literal value from the incident — Hospitable's own 429.
    expect(parseRetryAfterSeconds('2')).toBe(2)
    expect(parseRetryAfterSeconds(' 30 ')).toBe(30)
  })

  it('reads the HTTP-date form instead of producing NaN', () => {
    // THE BUG: parseInt('Wed, 21 Oct 2026 07:28:00 GMT') is NaN.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T07:27:30Z'))

    expect(parseRetryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(30)
  })

  it('falls back to 60 for an absent or unparseable header', () => {
    expect(parseRetryAfterSeconds(null)).toBe(60)
    expect(parseRetryAfterSeconds('')).toBe(60)
    expect(parseRetryAfterSeconds('soon')).toBe(60)
  })

  it('floors at 1 for a zero, negative or already-past value', () => {
    // step.sleep('0s') is an immediate retry; a negative duration is not a
    // duration at all.
    expect(parseRetryAfterSeconds('0')).toBe(1)
    expect(parseRetryAfterSeconds('-5')).toBe(1)

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T07:30:00Z'))
    expect(parseRetryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(1)
  })

  it('never returns NaN for any of these forms', () => {
    for (const header of ['2', 'Wed, 21 Oct 2026 07:28:00 GMT', 'garbage', '', null]) {
      expect(Number.isFinite(parseRetryAfterSeconds(header))).toBe(true)
    }
  })
})
