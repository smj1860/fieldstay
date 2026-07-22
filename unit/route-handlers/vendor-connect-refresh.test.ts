import { describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

import { GET } from '@/app/api/vendor-connect/[token]/refresh/route'

function getRequest(token: string) {
  return new NextRequest(`http://localhost/api/vendor-connect/${token}/refresh`)
}

function call(token: string) {
  return GET(getRequest(token), { params: Promise.resolve({ token }) })
}

const VALID_TOKEN = 'vendor-token-1234567890'

describe('GET /api/vendor-connect/[token]/refresh', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
  })

  it('redirects back to the onboard route for the same token, to generate a fresh account link', async () => {
    const res = await call(VALID_TOKEN)

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(
      `https://app.fieldstay.test/api/vendor-connect/${VALID_TOKEN}/onboard`
    )
  })

  it('carries a different token through unchanged, rather than a hardcoded/stale one', async () => {
    const res = await call('a-completely-different-token')

    expect(res.headers.get('location')).toBe(
      'https://app.fieldstay.test/api/vendor-connect/a-completely-different-token/onboard'
    )
  })

  // NO RATE LIMITING: unlike onboard/route.ts (vendorConnectRatelimit) and
  // work-orders/[token]/* routes (workOrderRatelimit), this route calls no
  // rate limiter at all. It never validates the token shape or existence
  // either — it just forwards whatever token is in the URL straight through
  // to /onboard, which does its own validation. Flagged per CLAUDE.md's
  // "Rate limiting on unauthenticated/token-guessable routes" standing item;
  // low incremental risk since /onboard re-validates and is itself rate
  // limited, but this route itself has zero throttling of its own.
  it('has no rate limiter guarding it — documents current (unthrottled) behavior', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => call(VALID_TOKEN))
    )

    expect(results.every((r) => r.status === 307)).toBe(true)
  })
})
