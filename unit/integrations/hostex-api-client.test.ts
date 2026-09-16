import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// hostexFetch / pagination.
//
// Hostex's two structural traps, both of which fail SILENTLY if mishandled:
//
//   1. HTTP status is ALWAYS 200 — a bad token, a validation error and a
//      throttle all arrive as 200. Judging the outcome on res.ok returns an
//      undefined payload that reads downstream as "this account has no
//      properties", and the sync then reports success having imported nothing.
//
//   2. Throttling is IN-BAND: 200 + error_code 429 + Retry-After. A
//      res.status === 429 branch never fires, so the request looks successful.
//
// Plus the pagination invariant: terminate on a short page, never on `total`,
// and never return a partial set quietly.
// ============================================================================

vi.mock('@/lib/rate-limit', () => ({
  checkLimit:             vi.fn(),
  hostexApiLimiter:       { limit: vi.fn() },
  // Hostex enforces per-minute AND per-hour ceilings that are not proportional
  // to each other; hostexFetch consults both — see the note above
  // hostexApiLimiter in lib/rate-limit.ts.
  hostexApiHourlyLimiter: { limit: vi.fn() },
  // Mirrors the real helper: an ERRORED decision carries no usable window
  // (checkLimit sets reset to Date.now()), so it backs off a full minute
  // instead of the ~1s that subtraction floors to. hostexFetch applies its own
  // withRetryJitter on top, so this is deliberately un-jittered.
  outboundBackoffSeconds: (d: { reset: number; errored: boolean }) =>
    d.errored ? 60 : Math.max(1, Math.ceil((d.reset - Date.now()) / 1000)),
}))

// This file is about hostexFetch's own request/response handling, not the
// breaker — unit/lib/circuit-breaker.test.ts and a dedicated wiring test
// cover that. Stubbed closed (same pattern as
// unit/lib/kroger-client-rate-limit.test.ts) so it never touches Redis:
// unit/setup.ts sets FAKE-but-present Upstash credentials, so an unmocked
// evaluateBreaker/recordFailure/recordSuccess here would make a REAL fetch to
// a bogus host and silently consume the very fetchMock responses these tests
// stage for the Hostex API call itself.
vi.mock('@/lib/integrations/circuit-breaker', async (orig) => ({
  ...(await orig<typeof import('@/lib/integrations/circuit-breaker')>()),
  evaluateBreaker: vi.fn(async () => ({ decision: 'closed', priorFailures: 0 })),
  recordFailure:   vi.fn(async () => undefined),
  recordSuccess:   vi.fn(async () => undefined),
}))

import { RetryAfterError } from 'inngest'
import {
  hostexDeleteWebhook,
  hostexFetch,
  hostexFetchProperties,
  hostexFetchReservationByCode,
  hostexFetchReviewByReservation,
  hostexReservationWindow,
  isHostexAccountActionError,
} from '@/lib/integrations/providers/hostex-api'
import { RateLimitError } from '@/lib/integrations/types'
import { checkLimit } from '@/lib/rate-limit'

/** Every hostexFetch throttle escapes as a RetryAfterError wrapping the
 * original RateLimitError as `cause` — see lib/inngest/retry-after.ts. A bare
 * RateLimitError used to reach Inngest uncaught, which retried on its own
 * generic backoff rather than the interval Hostex actually asked for. */
function causeRateLimit(err: unknown): RateLimitError {
  expect(err).toBeInstanceOf(RetryAfterError)
  const cause = (err as { cause?: unknown }).cause
  expect(cause).toBeInstanceOf(RateLimitError)
  return cause as RateLimitError
}

const USER = 'user_1'

function envelope(data: unknown, errorCode = 0, headers: Record<string, string> = {}) {
  return {
    ok:      true,
    status:  200,
    headers: { get: (k: string) => headers[k] ?? null },
    json:    async () => ({ request_id: 'r', error_code: errorCode, error_msg: 'msg', data }),
  } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkLimit).mockResolvedValue({ allowed: true, reset: Date.now() + 60_000 } as never)
})
afterEach(() => vi.unstubAllGlobals())

describe('hostexFetch', () => {
  it('unwraps data on the documented success code (0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ properties: [], total: 0 })))
    await expect(hostexFetch('/properties', 'tok', USER)).resolves.toEqual({ properties: [], total: 0 })
  })

  it('REJECTS error_code 200 — 0 is success, and 200 is not a Hostex code at all', async () => {
    // This adapter used to accept BOTH, because Hostex's OpenAPI schema
    // describes the field as "A value of 200 indicates success" while that same
    // schema's `example` is 0. Their Errors reference settles it — "error_code:
    // 0 means success. Any non-zero value is a failure" — and its complete code
    // table (0, 400, 401, 403, 404, 409, 420, 422, 429, 500, 501, 502, 503,
    // 504) contains no 200 whatsoever.
    //
    // Accepting both was never dangerous, since nothing emits 200. It is pinned
    // here because the danger is prospective: if Hostex ever gives 200 a
    // meaning, a permissive set reads that new failure as success on every
    // request, and the wrongly-widened member would look like a deliberate
    // compatibility allowance rather than a stale guess.
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ ok: true }, 200)))
    await expect(hostexFetch('/properties', 'tok', USER)).rejects.toThrow(/error_code 200/)
  })

  it('throws a RetryAfterError (wrapping RateLimitError) on an IN-BAND 429 carried by a 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope(null, 429, { 'Retry-After': '17' })))
    const err = await hostexFetch('/properties', 'tok', USER).catch((e: unknown) => e)
    causeRateLimit(err)
  })

  it('jitters Retry-After by ±25% so throttled connections do not retry in lockstep', async () => {
    // One deploy runs every org's syncs, so a platform-wide cron throttles
    // many connections at once. Hostex's rate-limit page asks for the header
    // value plus jitter for exactly this reason. Asserted as a BAND, not a
    // value — pinning the number would only be pinning Math.random.
    vi.stubGlobal('fetch', vi.fn(async () => envelope(null, 429, { 'Retry-After': '100' })))

    const seen = new Set<number>()
    for (let i = 0; i < 25; i++) {
      const err = await hostexFetch('/properties', 'tok', USER).catch((e: unknown) => e)
      const { retryAfter } = causeRateLimit(err)
      expect(retryAfter).toBeGreaterThanOrEqual(75)
      expect(retryAfter).toBeLessThanOrEqual(125)
      seen.add(retryAfter)
    }
    // Not a constant dressed up as jitter.
    expect(seen.size).toBeGreaterThan(1)
  })

  it('never jitters below a 1-second wait', async () => {
    // 0.75 x 1s rounds toward zero without the floor, and a 0s backoff retries
    // straight back into the window that just rejected us.
    vi.stubGlobal('fetch', vi.fn(async () => envelope(null, 429, { 'Retry-After': '1' })))
    for (let i = 0; i < 10; i++) {
      const err = await hostexFetch('/properties', 'tok', USER).catch((e: unknown) => e)
      expect(causeRateLimit(err).retryAfter).toBeGreaterThanOrEqual(1)
    }
  })

  it('throws on any other non-success error_code rather than returning undefined data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope(null, 40_001)))
    await expect(hostexFetch('/properties', 'tok', USER)).rejects.toThrow(/error_code 40001/)
  })

  describe('terminal vs retryable error codes', () => {
    // Hostex's Errors page marks these "do not retry" — the request is
    // malformed, the resource is not ours, or the ACCOUNT is the problem.
    // Throwing a plain Error meant Inngest retried each one three times.
    it.each([400, 401, 403, 404, 409, 420, 422, 501])(
      'stops Inngest retrying on error_code %i',
      async (code) => {
        vi.stubGlobal('fetch', vi.fn(async () => envelope(null, code)))
        const err = await hostexFetch('/properties', 'tok', USER).catch((e: Error) => e)
        expect((err as Error).name).toBe('NonRetriableError')
      },
    )

    // 5xx is Hostex's own fault or a downstream channel timing out; both are
    // worth another attempt.
    it.each([500, 502, 503, 504])('keeps error_code %i retryable', async (code) => {
      vi.stubGlobal('fetch', vi.fn(async () => envelope(null, code)))
      const err = await hostexFetch('/properties', 'tok', USER).catch((e: Error) => e)
      expect((err as Error).name).toBe('HostexApiError')
    })

    it('keeps an UNKNOWN code retryable rather than giving up on it', async () => {
      // Erring toward one wasted retry beats silently abandoning a sync
      // because Hostex added a code we have not read about yet.
      vi.stubGlobal('fetch', vi.fn(async () => envelope(null, 599)))
      const err = await hostexFetch('/properties', 'tok', USER).catch((e: Error) => e)
      expect((err as Error).name).toBe('HostexApiError')
    })

    it('flags the two codes only the HOST can resolve, through the wrapper', async () => {
      // 401 and 420 are both terminal, so they always arrive wrapped in a
      // NonRetriableError. A check that only tested the outer error would
      // match none of the cases it exists for.
      for (const code of [401, 420]) {
        vi.stubGlobal('fetch', vi.fn(async () => envelope(null, code)))
        const err = await hostexFetch('/properties', 'tok', USER).catch((e: unknown) => e)
        expect(isHostexAccountActionError(err)).toBe(true)
      }
    })

    it('does NOT flag an ordinary failure as needing host action', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => envelope(null, 422)))
      const err = await hostexFetch('/properties', 'tok', USER).catch((e: unknown) => e)
      expect(isHostexAccountActionError(err)).toBe(false)
    })
  })

  it('sends the Hostex-Access-Token header, not Authorization: Bearer', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => envelope({}))
    vi.stubGlobal('fetch', fetchMock)
    await hostexFetch('/properties', 'tok_abc', USER)

    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers['Hostex-Access-Token']).toBe('tok_abc')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('refuses the call when the rate-limit budget is unavailable (fails closed)', async () => {
    vi.mocked(checkLimit).mockResolvedValue({ allowed: false, reset: Date.now() + 5_000 } as never)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const err = await hostexFetch('/properties', 'tok', USER).catch((e: unknown) => e)
    causeRateLimit(err)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('pagination', () => {
  it('walks every page and stops on the first short one', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, title: `p${i}` }))
    const page2 = [{ id: 100, title: 'p100' }]

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(envelope({ properties: page1, total: 101 }))
      .mockResolvedValueOnce(envelope({ properties: page2, total: 101 }))
    vi.stubGlobal('fetch', fetchMock)

    const all = await hostexFetchProperties('tok', USER)
    expect(all).toHaveLength(101)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1]![0] as string)).toContain('offset=100')
  })

  it('throws rather than silently truncating when a page comes back unparseable', async () => {
    // Page 1 is a genuine full page; page 2's envelope is missing the
    // `properties` key entirely (a mangled/malformed response, not a real
    // short page). extract() returns undefined for it — the loop must not
    // read that as "zero rows, we're done" and hand back page 1 alone as if
    // it were the complete result.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, title: `p${i}` }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(envelope({ properties: page1, total: 150 }))
      .mockResolvedValueOnce(envelope({ totally_wrong_key: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(hostexFetchProperties('tok', USER)).rejects.toThrow(/unparseable/)
  })

  it('does not trust `total` — a wrong count neither truncates nor loops', async () => {
    // total lies (says 1), but the first page is full, so the walk continues.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, title: `p${i}` }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(envelope({ properties: page1, total: 1 }))
      .mockResolvedValueOnce(envelope({ properties: [], total: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(hostexFetchProperties('tok', USER)).resolves.toHaveLength(100)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('hostexReservationWindow', () => {
  it('always produces explicit bounds spanning history and lookahead', () => {
    // Hostex defaults to "the next 180 days" with no bounds, so an
    // unparameterised call returns a forward slice and NO history — which on
    // an initial sync looks like a PM with no past bookings.
    const w = hostexReservationWindow(12, 6, new Date('2026-08-16T00:00:00Z'))
    expect(w.startCheckOutDate).toBe('2025-08-16')
    expect(w.endCheckOutDate).toBe('2027-02-16')
  })
})

describe('hostexFetchReservationByCode', () => {
  // Hostex returns one object per STAY, and a single reservation_code can
  // legitimately span more than one (a multi-room-type or multi-property
  // booking) — hostexReservationToNormalized keys external_id on stay_code
  // for exactly this reason. A `limit: 1` re-read used to silently drop
  // every sibling stay past the first.
  it('returns EVERY stay under the reservation code, not just the first', async () => {
    const stays = [
      { id: 1, reservation_code: 'R1', stay_code: 'R1-A' },
      { id: 2, reservation_code: 'R1', stay_code: 'R1-B' },
    ]
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => envelope({ reservations: stays, total: 2 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(hostexFetchReservationByCode('tok', USER, 'R1')).resolves.toEqual(stays)

    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('reservation_code=R1')
    expect(url).not.toContain('limit=1&')
    expect(url).not.toMatch(/limit=1$/)
  })

  it('returns an empty array, not null, when the code matches nothing', async () => {
    // A hard-deleted-between-delivery-and-read reservation is a legitimate
    // outcome, not an error — callers flatten these results, and flattening
    // null would throw.
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ reservations: [], total: 0 })))
    await expect(hostexFetchReservationByCode('tok', USER, 'GONE')).resolves.toEqual([])
  })
})

describe('hostexFetchReviewByReservation', () => {
  it('returns EVERY review under the reservation code, not just the first', async () => {
    // Whether Hostex can return more than one review per reservation is
    // documented as unconfirmed either way — taking only [0] silently
    // resolved that uncertainty in the direction that drops data.
    const reviews = [
      { id: 1, reservation_code: 'R1' },
      { id: 2, reservation_code: 'R1' },
    ]
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => envelope({ reviews, total: 2 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(hostexFetchReviewByReservation('tok', USER, 'R1')).resolves.toEqual(reviews)

    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('reservation_code=R1')
  })

  it('returns an empty array, not null, when the reservation has no review', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ reviews: [], total: 0 })))
    await expect(hostexFetchReviewByReservation('tok', USER, 'NONE')).resolves.toEqual([])
  })
})

describe('hostexDeleteWebhook', () => {
  // Called on disconnect, BEFORE the token is revoked — DELETE /webhooks/{id}
  // needs it. Without this the PM disconnects and Hostex keeps pushing to a URL
  // our route answers 401 to, indefinitely, while their portal still lists a
  // FieldStay webhook for an integration the operator believes they removed.
  const OURS   = { id: 11, url: 'https://app/api/webhooks/hostex/tok', events: [], manageable: true,  created_at: '' }
  const THEIRS = { id: 22, url: 'https://app/api/webhooks/hostex/tok', events: [], manageable: false, created_at: '' }
  const OTHER  = { id: 33, url: 'https://elsewhere.example/hook',      events: [], manageable: true,  created_at: '' }

  function stubWebhooks(list: unknown[]) {
    const calls: Array<{ url: string; method?: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method })
      if (init?.method === 'DELETE') return envelope(null)
      return envelope({ webhooks: list })
    }))
    return calls
  }

  it('deletes only OUR manageable registration at that exact URL', async () => {
    const calls = stubWebhooks([OURS, OTHER])

    await expect(hostexDeleteWebhook('tok', USER, OURS.url)).resolves.toEqual({ deleted: 1 })

    const deletes = calls.filter((c) => c.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].url).toContain('/webhooks/11')
  })

  it('skips a registration flagged NOT manageable, which Hostex answers 403 for', async () => {
    // Hostex permits deleting only webhooks your own app created AND that are
    // manageable. A 403 is terminal here, so attempting it would fail the
    // disconnect for a reason the PM can do nothing about.
    const calls = stubWebhooks([THEIRS])

    await expect(hostexDeleteWebhook('tok', USER, THEIRS.url)).resolves.toEqual({ deleted: 0 })
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  it('is a no-op when nothing is registered — a disconnect must not fail on that', async () => {
    const calls = stubWebhooks([])
    await expect(hostexDeleteWebhook('tok', USER, OURS.url)).resolves.toEqual({ deleted: 0 })
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })
})
