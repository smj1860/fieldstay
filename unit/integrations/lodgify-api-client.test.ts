import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// lodgifyFetch / list-shape extraction / pagination.
//
// Lodgify's response shapes are the least-verified in this codebase — typed
// from published documentation, never from a live payload. That makes ONE
// behaviour load-bearing above all others: an unrecognised list shape must
// THROW, not return [].
//
// [] from a fetch is the input that turns any reconcile-by-absence pass into a
// mass delete (the `absence-reconciliation` guardrail, and the day an org's
// entire Hospitable crew roster was deactivated at the same microsecond), and
// on an initial sync it reports "0 properties, synced successfully" for an
// account full of them.
//
// Also pinned: 429 handling (Lodgify throttles by status, unlike Hostex's
// in-band envelope), terminal-vs-retryable classification, and the pagination
// invariant — terminate on a short page, never return a partial set quietly.
// ============================================================================

vi.mock('@/lib/rate-limit', () => ({
  checkLimit:        vi.fn(),
  lodgifyApiLimiter: { limit: vi.fn() },
  // Mirrors the real helper: an ERRORED decision carries no usable window
  // (checkLimit sets reset to Date.now()), so it backs off a full minute
  // instead of the ~1s that subtraction floors to.
  outboundBackoffSeconds: (d: { reset: number; errored: boolean }) =>
    d.errored ? 60 : Math.max(1, Math.ceil((d.reset - Date.now()) / 1000)),
}))

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

// This file is about lodgifyFetch's own request/response handling, not the
// breaker — unit/lib/circuit-breaker.test.ts covers that. Stubbed closed (the
// same pattern hostex-api-client.test.ts uses, and for the same reason):
// unit/setup.ts sets FAKE-but-present Upstash credentials, so an unmocked
// evaluateBreaker/recordFailure/recordSuccess would make a REAL fetch to a
// bogus host and silently consume the very fetchMock responses these tests
// stage for the Lodgify call itself.
vi.mock('@/lib/integrations/circuit-breaker', async (orig) => ({
  ...(await orig<typeof import('@/lib/integrations/circuit-breaker')>()),
  evaluateBreaker: vi.fn(async () => ({ decision: 'closed', priorFailures: 0 })),
  recordFailure:   vi.fn(async () => undefined),
  recordSuccess:   vi.fn(async () => undefined),
}))

import { RetryAfterError } from 'inngest'
import { evaluateBreaker, recordFailure } from '@/lib/integrations/circuit-breaker'
import {
  isLodgifyAuthFailure,
  lodgifyBookingWindow,
  lodgifyExtractItems,
  lodgifyFetch,
  lodgifyFetchBookingById,
  lodgifyFetchProperties,
} from '@/lib/integrations/providers/lodgify-api'
import { RateLimitError } from '@/lib/integrations/types'
import { checkLimit } from '@/lib/rate-limit'
import { reportError } from '@/lib/observability/report-error'

const USER = 'user_1'
const KEY  = 'test-api-key'

/**
 * Every lodgifyFetch throttle escapes as a RetryAfterError wrapping the
 * original RateLimitError as `cause` — see lib/inngest/retry-after.ts. A bare
 * RateLimitError reaching Inngest is retried on its own generic backoff curve
 * rather than the interval the provider actually asked for.
 */
function causeRateLimit(err: unknown): RateLimitError {
  expect(err).toBeInstanceOf(RetryAfterError)
  const cause = (err as { cause?: unknown }).cause
  expect(cause).toBeInstanceOf(RateLimitError)
  return cause as RateLimitError
}

function ok(body: unknown, status = 200): Response {
  return {
    ok:      status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json:    async () => body,
    text:    async () => JSON.stringify(body),
  } as unknown as Response
}

function err(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok:      false,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json:    async () => ({}),
    text:    async () => 'error body',
  } as unknown as Response
}

/** A full page (50 rows), so pagination continues. */
function fullPage(startId: number) {
  return { count: 999, items: Array.from({ length: 50 }, (_, i) => ({ id: startId + i })) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkLimit).mockResolvedValue({ allowed: true, reset: Date.now() + 60_000 } as never)
})
afterEach(() => vi.unstubAllGlobals())

describe('lodgifyExtractItems', () => {
  it('accepts the documented { count, items } envelope', () => {
    expect(lodgifyExtractItems<{ id: number }>({ count: 1, items: [{ id: 7 }] }, 'test')).toEqual([{ id: 7 }])
  })

  it('accepts a bare array, which some endpoints are reported to return', () => {
    expect(lodgifyExtractItems<{ id: number }>([{ id: 7 }], 'test')).toEqual([{ id: 7 }])
  })

  it('accepts a genuinely empty account without complaint', () => {
    expect(lodgifyExtractItems({ count: 0, items: [] }, 'test')).toEqual([])
  })

  it('THROWS on an unrecognised shape rather than returning []', () => {
    // The single most important line in this file. Returning [] here would
    // make a misparsed response indistinguishable from an empty account.
    expect(() => lodgifyExtractItems({ data: [{ id: 7 }] }, 'properties')).toThrow(/unrecognized list shape/)
  })

  it('reports the KEYS it saw, never the values', () => {
    // Keys make the fix one Sentry issue away. Values would put guest PII into
    // an error message that reaches integration_connections.metadata.
    expect(() => lodgifyExtractItems({ results: [], guest_email: 'a@b.com' }, 'bookings')).toThrow()

    const [reported] = vi.mocked(reportError).mock.calls.at(-1) ?? []
    expect((reported as Error).message).toContain('results')
    expect((reported as Error).message).not.toContain('a@b.com')
  })
})

describe('lodgifyFetch: throttling and classification', () => {
  it('throws RateLimitError on a 429, honouring Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(err(429, { 'Retry-After': '30' })))

    const thrown = await lodgifyFetch('/properties', KEY, USER).catch((e: unknown) => e)
    const inner  = causeRateLimit(thrown)
    // Jittered ±25% around 30.
    expect(inner.retryAfter).toBeGreaterThanOrEqual(22)
    expect(inner.retryAfter).toBeLessThanOrEqual(38)
  })

  it('refuses to call at all when the outbound budget is spent — fails CLOSED', async () => {
    // The budget exists to throw BEFORE Lodgify throttles us, and Lodgify's
    // real ceiling is unverified. A fail-open here would blow through it.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(checkLimit).mockResolvedValue({ allowed: false, errored: true, reset: Date.now() } as never)

    const thrown = await lodgifyFetch('/properties', KEY, USER).catch((e: unknown) => e)
    causeRateLimit(thrown)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marks a 401 terminal AND recognisable as an auth failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(err(401)))

    const thrown = await lodgifyFetch('/properties', KEY, USER).catch((e: unknown) => e)
    // Wrapped so Inngest stops immediately; the typed cause survives so the
    // caller can still tell "reconnect required" from "try again".
    expect((thrown as Error).name).toBe('NonRetriableError')
    expect(isLodgifyAuthFailure(thrown)).toBe(true)
  })

  it('leaves a 5xx retryable — an unknown failure errs toward trying again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(err(503)))

    const thrown = await lodgifyFetch('/properties', KEY, USER).catch((e: unknown) => e)
    expect((thrown as Error).name).not.toBe('NonRetriableError')
    expect(isLodgifyAuthFailure(thrown)).toBe(false)
  })

  it('sends the key in X-ApiKey, not as a Bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await lodgifyFetch('/properties', KEY, USER)

    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>
    expect(headers['X-ApiKey']).toBe(KEY)
    expect(headers.Authorization).toBeUndefined()
  })
})

describe('lodgifyFetch: circuit breaker', () => {
  it('refuses to call when the circuit is open', async () => {
    // Without this, every independent Lodgify sync across every connected org
    // keeps calling through a provider-wide outage, each waiting out the full
    // timeout and then being retried by Inngest's backoff.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(evaluateBreaker).mockResolvedValueOnce({ decision: 'open', priorFailures: 5 } as never)

    const thrown = await lodgifyFetch('/properties', KEY, USER).catch((e: unknown) => e)
    expect((thrown as Error).name).toBe('NonRetriableError')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('counts a 5xx as a breaker failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(err(503)))

    await lodgifyFetch('/properties', KEY, USER).catch(() => undefined)
    expect(vi.mocked(recordFailure)).toHaveBeenCalledWith('lodgify')
  })

  it('does NOT count a 429 as a breaker failure', async () => {
    // A provider working correctly and telling us to slow down is not the
    // provider failing — same exemption hostexFetch and krogerFetch make.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(err(429, { 'Retry-After': '5' })))

    await lodgifyFetch('/properties', KEY, USER).catch(() => undefined)
    expect(vi.mocked(recordFailure)).not.toHaveBeenCalled()
  })

  it('does NOT count a terminal 4xx as a breaker failure', async () => {
    // A 401/404/422 is US being wrong or an account-level condition, not
    // Lodgify's service degrading.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(err(422)))

    await lodgifyFetch('/properties', KEY, USER).catch(() => undefined)
    expect(vi.mocked(recordFailure)).not.toHaveBeenCalled()
  })
})

describe('lodgifyFetchProperties: pagination', () => {
  it('stops on a short page and returns every row', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(fullPage(1)))
      .mockResolvedValueOnce(ok({ count: 999, items: [{ id: 51 }] }))
    vi.stubGlobal('fetch', fetchMock)

    const rows = await lodgifyFetchProperties(KEY, USER)
    expect(rows).toHaveLength(51)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('terminates on the short page even when `count` claims there is more', async () => {
    // Terminating on `count` would let a stale or wrong total cause either an
    // early stop (silent data loss) or an endless loop.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ count: 10_000, items: [{ id: 1 }] })))

    await expect(lodgifyFetchProperties(KEY, USER)).resolves.toHaveLength(1)
  })

  it('pages from 1, matching Lodgify own examples', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await lodgifyFetchProperties(KEY, USER)
    expect(fetchMock.mock.calls[0]![0]).toContain('page=1')
  })
})

describe('lodgifyFetchBookingById', () => {
  it('returns null for a booking Lodgify no longer recognises', async () => {
    // A booking hard-deleted between a webhook delivery and this read is a
    // legitimate outcome, not an error to retry.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(err(404)))
    await expect(lodgifyFetchBookingById(KEY, USER, '9001')).resolves.toBeNull()
  })

  it('URL-encodes the id it was handed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ id: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    await lodgifyFetchBookingById(KEY, USER, '90 01')
    expect(fetchMock.mock.calls[0]![0]).toContain('90%2001')
  })
})

describe('lodgifyBookingWindow', () => {
  it('spans history back and lookahead forward as YYYY-MM-DD', () => {
    const w = lodgifyBookingWindow(12, 6)
    expect(w.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(w.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(w.startDate < w.endDate).toBe(true)
  })
})
