// Tests krogerFetch — the shared rate-limit wrapper in lib/kroger/client.ts
// used by every outbound Kroger API call (product search, cart add,
// location lookup, token/identity calls). See
// docs/SCALABILITY_TIERS_REMAINING.md item 3 and lib/rate-limit.ts's
// kroger*ApiLimiter exports.
//
// Unlike unit/inngest/kroger-connected.test.ts and
// unit/inngest/build-shopping-cart.test.ts (which mock '@/lib/kroger/client'
// wholesale to isolate the Inngest function under test), this file mocks
// '@/lib/rate-limit' instead and exercises the REAL lib/kroger/client.ts
// implementation, so the limiter-consultation / 429 / fail-CLOSED behavior
// itself is what's under test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// krogerFetch consults the limiters through checkLimit() rather than calling
// `.limit()` on them directly, so checkLimit is the seam these tests control.
// The limiter objects themselves are opaque tokens here — what matters is
// WHICH one krogerFetch hands to checkLimit for a given endpoint class.
const checkLimitMock = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  krogerAuthApiLimiter:      { __limiter: 'kroger-auth' },
  krogerProductsApiLimiter:  { __limiter: 'kroger-products' },
  krogerLocationsApiLimiter: { __limiter: 'kroger-locations' },
  krogerCartApiLimiter:      { __limiter: 'kroger-cart' },
  checkLimit:                (...args: unknown[]) => checkLimitMock(...args),
  retryAfterSeconds:         (d: { reset: number }) =>
    Math.max(1, Math.ceil((d.reset - Date.now()) / 1000)),
}))

import { searchProducts, addItemsToKrogerCart, findNearestKrogerStore } from '@/lib/kroger/client'
import { RateLimitError } from '@/lib/integrations/types'
import { krogerProductsApiLimiter } from '@/lib/rate-limit'

/** A checkLimit() decision, with the fields krogerFetch actually reads. */
function decision(over: Partial<{ allowed: boolean; errored: boolean; reset: number }> = {}) {
  return {
    allowed:   true,
    skipped:   false,
    errored:   false,
    limit:     9_000,
    remaining: 8_999,
    reset:     Date.now() + 1_000,
    ...over,
  }
}

function okJson(body: unknown) {
  return {
    ok:      true,
    status:  200,
    headers: new Headers(),
    json:    async () => body,
    text:    async () => JSON.stringify(body),
  }
}

function rateLimited(retryAfterSeconds: string) {
  return {
    ok:      false,
    status:  429,
    headers: new Headers({ 'Retry-After': retryAfterSeconds }),
    json:    async () => ({}),
    text:    async () => '',
  }
}

describe('lib/kroger/client — krogerFetch rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('consults the endpoint-class limiter BEFORE making the outbound request', async () => {
    const callOrder: string[] = []
    checkLimitMock.mockImplementation(async () => {
      callOrder.push('limiter')
      return decision()
    })
    const fetchMock = vi.fn().mockImplementation(async () => {
      callOrder.push('fetch')
      return okJson({ data: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await searchProducts('paper towels', 'loc_1', 'token_x')

    // The Products endpoint class gets its own limiter and its own fixed,
    // platform-wide identifier — not a per-org key.
    expect(checkLimitMock).toHaveBeenCalledWith(
      krogerProductsApiLimiter,
      'kroger-products',
      // 'deny' — these are Kroger's published DAILY quotas, an external spend
      // ceiling. A ceiling that disappears during a Redis outage is not a
      // ceiling (same stance as claimNudgeBudgetSlot in CLAUDE.md).
      { onError: 'deny', site: 'lib.kroger.client.krogerFetch.kroger-products' },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(['limiter', 'fetch'])
  })

  it('throws RateLimitError proactively — without ever calling fetch — once the shared budget reports exhausted', async () => {
    checkLimitMock.mockResolvedValue(decision({ allowed: false, reset: Date.now() + 5_000 }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchProducts('paper towels', 'loc_1', 'token_x')).rejects.toBeInstanceOf(RateLimitError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reacts to a genuine 429 from Kroger by throwing RateLimitError with the exact Retry-After wait time', async () => {
    checkLimitMock.mockResolvedValue(decision())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rateLimited('42')))

    let caught: unknown
    try {
      await addItemsToKrogerCart([{ upc: '0001111041700', quantity: 1, modality: 'PICKUP' }], 'customer_token')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RateLimitError)
    expect((caught as RateLimitError).retryAfter).toBe(42)
  })

  it('falls back to a 60s default Retry-After when Kroger 429s without the header', async () => {
    checkLimitMock.mockResolvedValue(decision())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, headers: new Headers(), text: async () => '',
    }))

    let caught: unknown
    try {
      await findNearestKrogerStore('35007', 'token_x')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RateLimitError)
    expect((caught as RateLimitError).retryAfter).toBe(60)
  })

  // Behaviour change (was: "fails OPEN — still makes the real request").
  // Kroger's limiters are external DAILY quota ceilings, so krogerFetch now
  // declares onError: 'deny' and checkLimit returns an errored, DISALLOWED
  // decision when Redis is down. Failing open here would let cart automation
  // burn Kroger's 10,000/day Products budget during an outage and take the
  // feature out for every tenant until the next daily reset.
  it('fails CLOSED — never reaches the network — when the limiter check itself errors (Redis unavailable)', async () => {
    checkLimitMock.mockResolvedValue(decision({ allowed: false, errored: true, reset: Date.now() }))
    const fetchMock = vi.fn().mockResolvedValue(okJson({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)

    let caught: unknown
    try {
      await searchProducts('paper towels', 'loc_1', 'token_x')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RateLimitError)
    // An errored decision has no real window to wait for (reset is Date.now(),
    // which retryAfterSeconds would floor to 1s), so it backs off a full
    // minute instead of hammering a Redis outage with immediate retries.
    expect((caught as RateLimitError).retryAfter).toBe(60)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // A genuinely-exhausted budget and an errored decision both deny, but they
  // must not collapse into the same backoff: a real window has a real reset to
  // wait for, so the caller is told to retry when it actually reopens rather
  // than being handed the errored path's blanket 60s.
  it('derives Retry-After from the real reset window when the budget is exhausted but Redis is healthy', async () => {
    checkLimitMock.mockResolvedValue(decision({ allowed: false, reset: Date.now() + 2_000 }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let caught: unknown
    try {
      await searchProducts('paper towels', 'loc_1', 'token_x')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RateLimitError)
    expect((caught as RateLimitError).retryAfter).toBe(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
