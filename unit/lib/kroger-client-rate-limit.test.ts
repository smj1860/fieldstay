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
// implementation, so the limiter-consultation / 429 / fail-open behavior
// itself is what's under test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/rate-limit', () => ({
  krogerAuthApiLimiter:      { limit: vi.fn() },
  krogerProductsApiLimiter:  { limit: vi.fn() },
  krogerLocationsApiLimiter: { limit: vi.fn() },
  krogerCartApiLimiter:      { limit: vi.fn() },
}))

import { searchProducts, addItemsToKrogerCart, findNearestKrogerStore } from '@/lib/kroger/client'
import { RateLimitError } from '@/lib/integrations/types'
import {
  krogerProductsApiLimiter,
  krogerCartApiLimiter,
  krogerLocationsApiLimiter,
} from '@/lib/rate-limit'

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
    ;(krogerProductsApiLimiter.limit as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('limiter')
      return { success: true, reset: Date.now() + 1_000 }
    })
    const fetchMock = vi.fn().mockImplementation(async () => {
      callOrder.push('fetch')
      return okJson({ data: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await searchProducts('paper towels', 'loc_1', 'token_x')

    expect(krogerProductsApiLimiter.limit).toHaveBeenCalledWith('kroger-products')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(['limiter', 'fetch'])
  })

  it('throws RateLimitError proactively — without ever calling fetch — once the shared budget reports exhausted', async () => {
    const resetAt = Date.now() + 5_000
    ;(krogerProductsApiLimiter.limit as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, reset: resetAt })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchProducts('paper towels', 'loc_1', 'token_x')).rejects.toBeInstanceOf(RateLimitError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reacts to a genuine 429 from Kroger by throwing RateLimitError with the exact Retry-After wait time', async () => {
    ;(krogerCartApiLimiter.limit as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, reset: Date.now() + 1_000 })
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
    ;(krogerLocationsApiLimiter.limit as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, reset: Date.now() + 1_000 })
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

  it('fails OPEN — still makes the real request — when the limiter check itself errors (Redis unavailable)', async () => {
    ;(krogerProductsApiLimiter.limit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'))
    const fetchMock = vi.fn().mockResolvedValue(okJson({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await searchProducts('paper towels', 'loc_1', 'token_x')

    // Proceeded to the real call instead of throwing — an abuse/quota
    // limiter fails open on infra errors, unlike a spend-budget limiter.
    expect(result).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not fail open for a genuine RateLimitError — only for the limiter check erroring', async () => {
    // Guards against a regression that would swallow the proactive
    // RateLimitError itself into the fail-open branch.
    ;(krogerProductsApiLimiter.limit as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      reset:   Date.now() + 2_000,
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchProducts('paper towels', 'loc_1', 'token_x')).rejects.toBeInstanceOf(RateLimitError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
