import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/app/actions/guidebook', () => ({
  createSponsorCheckoutSession: vi.fn(),
}))
vi.mock('@/lib/rate-limit', async () => {
  // checkLimit() is now the only sanctioned way to consult a limiter
  // (lib/rate-limit.ts). The stub delegates to the limiter doubles below
  // so existing `.limit` assertions and fail-policy tests still apply.
  const { checkLimitStub, retryAfterSecondsStub } = await import('@/unit/stubs/rate-limit')
  return {
    guidebookSponsorCheckoutLimiter: { limit: vi.fn(async () => ({ success: true })) },
    checkLimit:         checkLimitStub(),
    retryAfterSeconds:  retryAfterSecondsStub,
  }
})

import { POST } from '@/app/api/guidebook/sponsor-checkout/route'
import { createSponsorCheckoutSession } from '@/app/actions/guidebook'
import { guidebookSponsorCheckoutLimiter } from '@/lib/rate-limit'

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/guidebook/sponsor-checkout', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

// Real UUIDs: guidebook_sponsors.media_kit_token is a `uuid` column, so the
// previous fixture ('kit-token-abc-123') could not have existed in production
// — against the live schema it is error 22P02, not a miss. The suite was green
// on input the database would have rejected outright.
const KIT_TOKEN     = '66666666-6666-4666-8666-666666666666'
const MISSING_TOKEN = '77777777-7777-4777-8777-777777777777'

describe('POST /api/guidebook/sponsor-checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(guidebookSponsorCheckoutLimiter.limit).mockResolvedValue({ success: true } as never)
  })

  it('returns 429 without touching the checkout action when the limiter denies', async () => {
    vi.mocked(guidebookSponsorCheckoutLimiter.limit).mockResolvedValue({ success: false } as never)

    const res  = await POST(postRequest({ mediaKitToken: KIT_TOKEN }))
    const json = await res.json()

    expect(res.status).toBe(429)
    expect(json).toEqual({ error: 'Too many requests. Please try again later.' })
    expect(createSponsorCheckoutSession).not.toHaveBeenCalled()
  })

  it('throttles before the token is read, so a guessing attack is capped by the limiter and not by token entropy', async () => {
    const callOrder: string[] = []
    vi.mocked(guidebookSponsorCheckoutLimiter.limit).mockImplementation(async () => {
      callOrder.push('limit')
      return { success: true } as never
    })
    vi.mocked(createSponsorCheckoutSession).mockImplementation(async () => {
      callOrder.push('lookup')
      return { url: 'https://checkout.stripe.com/pay/cs_1' }
    })

    await POST(postRequest({ mediaKitToken: KIT_TOKEN }))

    expect(callOrder).toEqual(['limit', 'lookup'])
  })

  // extractClientIp prefers platform-set headers and, falling back to
  // x-forwarded-for, reads the RIGHTMOST entry — a client-prepended value must
  // not become the rate-limit key, or each request mints its own bucket.
  it('keys the limiter on the platform-set caller IP, not a client-supplied one', async () => {
    const req = new NextRequest('http://localhost/api/guidebook/sponsor-checkout', {
      method:  'POST',
      headers: {
        'content-type':    'application/json',
        'x-real-ip':       '203.0.113.7',
        'x-forwarded-for': '1.2.3.4, 203.0.113.7',
      },
      body:    JSON.stringify({ mediaKitToken: KIT_TOKEN }),
    })
    vi.mocked(createSponsorCheckoutSession).mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_1' })

    await POST(req)

    expect(guidebookSponsorCheckoutLimiter.limit).toHaveBeenCalledWith('203.0.113.7')
    expect(guidebookSponsorCheckoutLimiter.limit).not.toHaveBeenCalledWith('1.2.3.4')
  })

  it('rejects a request with no mediaKitToken before calling the checkout action', async () => {
    const res = await POST(postRequest({}))

    expect(res.status).toBe(400)
    expect(createSponsorCheckoutSession).not.toHaveBeenCalled()
  })

  it('rejects a non-string mediaKitToken', async () => {
    const res = await POST(postRequest({ mediaKitToken: 12345 }))

    expect(res.status).toBe(400)
    expect(createSponsorCheckoutSession).not.toHaveBeenCalled()
  })

  it('rejects a malformed mediaKitToken as an invalid link, without reaching the action', async () => {
    const res  = await POST(postRequest({ mediaKitToken: 'kit-token-abc-123' }))
    const json = await res.json()

    // media_kit_token is a uuid. A well-formed-but-not-UUID string used to
    // sail past the typeof check into the action's `.eq()`, hit 22P02, throw
    // out of unwrap(), and land in the action's catch — which reports to
    // Sentry and tells the sponsor "Unable to start checkout. Please try
    // again." for a link that will never work however many times they try.
    expect(res.status).toBe(400)
    expect(json).toEqual({ error: 'Invalid media kit link.' })
    expect(createSponsorCheckoutSession).not.toHaveBeenCalled()
  })

  it('passes the exact client-supplied mediaKitToken through to the action unmodified — the action itself is the only place org scoping happens (media_kit_token lookup)', async () => {
    vi.mocked(createSponsorCheckoutSession).mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_1' })

    await POST(postRequest({ mediaKitToken: KIT_TOKEN }))

    expect(createSponsorCheckoutSession).toHaveBeenCalledWith(KIT_TOKEN)
  })

  it('returns the checkout URL on success', async () => {
    vi.mocked(createSponsorCheckoutSession).mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_1' })

    const res = await POST(postRequest({ mediaKitToken: KIT_TOKEN }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ url: 'https://checkout.stripe.com/pay/cs_1' })
  })

  it('surfaces an action-level error (e.g. invalid/unknown token) as a 400, not a 500', async () => {
    vi.mocked(createSponsorCheckoutSession).mockResolvedValue({ error: 'Invalid media kit link.' })

    const res = await POST(postRequest({ mediaKitToken: MISSING_TOKEN }))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json).toEqual({ error: 'Invalid media kit link.' })
  })

  it('returns a generic 500 (no raw error detail) when the action throws unexpectedly', async () => {
    vi.mocked(createSponsorCheckoutSession).mockRejectedValue(new Error('stripe network timeout'))

    const res = await POST(postRequest({ mediaKitToken: KIT_TOKEN }))
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json).toEqual({ error: 'Internal server error' })
  })

  it('returns 400 when the sponsorship slot is already active (a real auth-model rejection for this token route)', async () => {
    vi.mocked(createSponsorCheckoutSession).mockResolvedValue({ error: 'This sponsorship slot is already active.' })

    const res = await POST(postRequest({ mediaKitToken: KIT_TOKEN }))

    expect(res.status).toBe(400)
  })
})
