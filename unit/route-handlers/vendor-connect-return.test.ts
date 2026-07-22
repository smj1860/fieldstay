import { describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

import { GET } from '@/app/api/vendor-connect/[token]/return/route'

function getRequest(token: string, search = '') {
  return new NextRequest(`http://localhost/api/vendor-connect/${token}/return${search}`)
}

function call(token: string, search = '') {
  return GET(getRequest(token, search), { params: Promise.resolve({ token }) })
}

const VALID_TOKEN = 'vendor-token-1234567890'

describe('GET /api/vendor-connect/[token]/return', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
  })

  it('redirects to the vendor-connect status page for the token', async () => {
    const res = await call(VALID_TOKEN)

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(
      `https://app.fieldstay.test/vendor-connect/${VALID_TOKEN}/status`
    )
  })

  it('carries the already_onboarded=true flag through to the status page when present', async () => {
    const res = await call(VALID_TOKEN, '?already_onboarded=true')

    const location = new URL(res.headers.get('location')!)
    expect(location.pathname).toBe(`/vendor-connect/${VALID_TOKEN}/status`)
    expect(location.searchParams.get('already_onboarded')).toBe('true')
  })

  it('does not set already_onboarded when the query param is absent', async () => {
    const res = await call(VALID_TOKEN)

    const location = new URL(res.headers.get('location')!)
    expect(location.searchParams.has('already_onboarded')).toBe(false)
  })

  // NO RATE LIMITING, NO TOKEN VALIDATION: like refresh/route.ts, this route
  // never calls a rate limiter and never checks the token against the DB —
  // it's a pure redirect that forwards the token straight into the status
  // page URL. Flagged per CLAUDE.md's "Rate limiting on unauthenticated/
  // token-guessable routes" item.
  it('has no rate limiter guarding it — documents current (unthrottled) behavior', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => call(VALID_TOKEN))
    )

    expect(results.every((r) => r.status === 307)).toBe(true)
  })
})
