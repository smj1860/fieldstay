import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// Does krogerFetch actually CONSULT the breaker?
//
// unit/lib/circuit-breaker.test.ts tests the breaker in isolation, and
// unit/lib/kroger-client-rate-limit.test.ts stubs it out to stay focused on
// rate limiting — so between them, deleting the breaker check from
// krogerFetch entirely broke NOTHING. Verified by doing exactly that: both
// files stayed green. This file is the wiring test that closes that gap.
//
// A fix nothing fails without is not a verified fix.
// ============================================================================

const checkLimitMock = vi.fn()
const failureCountMock  = vi.fn()
const recordFailureMock = vi.fn()
const recordSuccessMock = vi.fn()

vi.mock('@/lib/rate-limit', () => ({
  krogerAuthApiLimiter:      { __limiter: 'kroger-auth' },
  krogerProductsApiLimiter:  { __limiter: 'kroger-products' },
  krogerLocationsApiLimiter: { __limiter: 'kroger-locations' },
  krogerCartApiLimiter:      { __limiter: 'kroger-cart' },
  checkLimit:                (...args: unknown[]) => checkLimitMock(...args),
  retryAfterSeconds:         () => 1,
}))
vi.mock('@/lib/integrations/circuit-breaker', async (orig) => ({
  ...(await orig<typeof import('@/lib/integrations/circuit-breaker')>()),
  failureCount:  (...a: unknown[]) => failureCountMock(...a),
  recordFailure: (...a: unknown[]) => recordFailureMock(...a),
  recordSuccess: (...a: unknown[]) => recordSuccessMock(...a),
}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { NonRetriableError } from 'inngest'
import { searchProducts } from '@/lib/kroger/client'
import { CIRCUIT_BREAKER_CONFIG } from '@/lib/integrations/circuit-breaker'

const OPEN   = CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD
const CLOSED = 0

let fetchMock: ReturnType<typeof vi.fn>

function ok(body: unknown = { data: [] }) {
  return { ok: true, status: 200, json: async () => body, headers: new Headers() }
}

beforeEach(() => {
  vi.clearAllMocks()
  checkLimitMock.mockResolvedValue({ allowed: true, skipped: false, errored: false, limit: 1, remaining: 1, reset: Date.now() })
  failureCountMock.mockResolvedValue(CLOSED)
  fetchMock = vi.fn(async () => ok())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { vi.unstubAllGlobals() })

describe('krogerFetch consults the circuit breaker', () => {
  it('makes the call when the circuit is closed', async () => {
    await searchProducts('token', 'paper towels', 'loc_1').catch(() => {})
    expect(failureCountMock).toHaveBeenCalledWith('kroger')
    expect(fetchMock).toHaveBeenCalled()
  })

  it('SKIPS the call entirely when the circuit is open', async () => {
    failureCountMock.mockResolvedValue(OPEN)

    await expect(searchProducts('token', 'paper towels', 'loc_1')).rejects.toThrow(/circuit is open/)
    // The whole point: no outbound request, so no full-timeout wait added to a
    // provider that is already failing.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws NonRetriable when open — retrying is the amplification', async () => {
    failureCountMock.mockResolvedValue(OPEN)
    await expect(searchProducts('token', 'x', 'loc_1')).rejects.toBeInstanceOf(NonRetriableError)
  })

  it('checks the breaker BEFORE the rate limiter has any chance to allow a call through', async () => {
    failureCountMock.mockResolvedValue(OPEN)
    await searchProducts('token', 'x', 'loc_1').catch(() => {})
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('krogerFetch feeds the breaker', () => {
  it('records a failure on a transport error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    await searchProducts('token', 'x', 'loc_1').catch(() => {})
    expect(recordFailureMock).toHaveBeenCalledWith('kroger')
  })

  it('records a failure on a 5xx — the provider is failing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}), headers: new Headers() })
    await searchProducts('token', 'x', 'loc_1').catch(() => {})
    expect(recordFailureMock).toHaveBeenCalledWith('kroger')
  })

  it('does NOT record a failure on 429 — that is Kroger working correctly', async () => {
    // Counting rate-limit responses would open the circuit on our own
    // throughput rather than their health. RateLimitError already handles it.
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}), headers: new Headers([['Retry-After', '30']]) })
    await searchProducts('token', 'x', 'loc_1').catch(() => {})
    expect(recordFailureMock).not.toHaveBeenCalled()
  })

  it('does NOT record a failure on a 4xx — that is our request being wrong', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}), headers: new Headers() })
    await searchProducts('token', 'x', 'loc_1').catch(() => {})
    expect(recordFailureMock).not.toHaveBeenCalled()
  })

  it('skips the clearing DEL on a healthy call when nothing is counted', async () => {
    // The count is already in hand from the pre-check, so an unconditional
    // recordSuccess would add a Redis round-trip to every successful call.
    failureCountMock.mockResolvedValue(0)
    await searchProducts('token', 'x', 'loc_1').catch(() => {})
    expect(recordSuccessMock).not.toHaveBeenCalled()
  })

  it('DOES clear on a success that follows recorded failures (recovery)', async () => {
    failureCountMock.mockResolvedValue(2)
    await searchProducts('token', 'x', 'loc_1').catch(() => {})
    expect(recordSuccessMock).toHaveBeenCalledWith('kroger')
  })
})
