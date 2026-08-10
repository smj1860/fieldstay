import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ============================================================================
// P3-1: what the middleware is allowed to SPEND per request.
//
// Two separate costs were being paid on effectively every request in the app:
//
//   A. updateSession() ran BEFORE the public-route check, so an anonymous
//      visitor on /, /login, /signup or /forgot-password triggered Supabase
//      Auth work for a request that by definition has no session. That made
//      Auth's uptime and latency a dependency of the entire public site.
//   B. updateSession() used getUser(), a GoTrue network round trip, and the
//      page/Server Action underneath then called getUser() AGAIN through
//      getAuthContext(). React cache() cannot dedupe those — they are separate
//      execution contexts — so it was two sequential network calls per
//      authenticated request.
//
// These tests pin the fix at the seam that matters: whether the Auth client is
// CONSTRUCTED AT ALL. Asserting on latency is untestable; asserting that no
// Supabase client was built for an anonymous public request is exact.
// ============================================================================

vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  redis: {},
  checkLimit: vi.fn(async () => ({
    allowed: true, skipped: true, errored: false, limit: 0, remaining: 0, reset: 0,
  })),
  ownerPortalRatelimit:  {}, workOrderTokenRatelimit: {}, guidebookRatelimit: {},
  inviteAcceptRatelimit: {}, tokenResourceRatelimit:  {},
}))

import { createServerClient } from '@supabase/ssr'
import { proxy } from '@/proxy'

/** A Supabase client whose auth surface records which method was reached. */
function mockAuthClient(claims: { sub: string } | null) {
  const getClaims  = vi.fn(async () => ({ data: claims ? { claims } : null }))
  const getUser    = vi.fn(async () => ({ data: { user: null } }))
  const getSession = vi.fn(async () => ({ data: { session: null } }))

  vi.mocked(createServerClient).mockImplementation((() => ({
    auth: { getClaims, getUser, getSession },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any)

  return { getClaims, getUser, getSession }
}

function req(path: string, cookie?: string) {
  return new NextRequest(`https://app.fieldstay.test${path}`, {
    headers: cookie ? { cookie } : undefined,
  })
}

// @supabase/ssr chunks a large session across `.0`, `.1`, … Both shapes must
// count as "has a session".
const WHOLE_COOKIE   = 'sb-vpmznjktllhmmbfnxuvk-auth-token=eyJhbGciOiJFUzI1NiJ9.x.y'
const CHUNKED_COOKIE = 'sb-vpmznjktllhmmbfnxuvk-auth-token.0=eyJhbGciOiJ; sb-vpmznjktllhmmbfnxuvk-auth-token.1=Fcy1NiJ9'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL      = 'https://unit-test.invalid'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'unit-test-anon-key'
})

describe('proxy: anonymous traffic on a public route costs no Auth work', () => {
  it.each(['/login', '/signup', '/forgot-password'])(
    'builds no Supabase client at all for %s with no session cookie',
    async (path) => {
      mockAuthClient(null)

      const res = await proxy(req(path))

      // The strongest available assertion: the client is never constructed, so
      // no Auth call of any kind can have happened.
      expect(createServerClient).not.toHaveBeenCalled()
      expect(res.status).toBe(200)
    },
  )

  it('still resolves the session on a public route when a session cookie IS present', async () => {
    // The skip must be driven by the cookie, not by the route class — an
    // authenticated user landing on /login is redirected into the app, and
    // that decision needs the session.
    const auth = mockAuthClient({ sub: 'user_1' })

    const res = await proxy(req('/login', WHOLE_COOKIE))

    expect(createServerClient).toHaveBeenCalled()
    expect(auth.getClaims).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/ops')
  })

  it('recognises a CHUNKED session cookie, not just the whole one', async () => {
    // endsWith('-auth-token') is the obvious way to write this check and it is
    // wrong: it misses `…-auth-token.0`, so the users with the LARGEST sessions
    // would be treated as anonymous and never redirected off /login.
    const auth = mockAuthClient({ sub: 'user_1' })

    await proxy(req('/login', CHUNKED_COOKIE))

    expect(createServerClient).toHaveBeenCalled()
    expect(auth.getClaims).toHaveBeenCalledTimes(1)
  })

  it('a protected route with no session still resolves auth, then redirects to /login', async () => {
    // The skip is scoped to PUBLIC routes. A protected route must not be able
    // to shortcut the check just because no cookie was sent.
    mockAuthClient(null)

    const res = await proxy(req('/ops'))

    expect(createServerClient).toHaveBeenCalled()
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login')
  })
})

describe('proxy: session resolution is local, not a network round trip', () => {
  it('reaches getClaims() and never getUser()/getSession()', async () => {
    const auth = mockAuthClient({ sub: 'user_1' })

    await proxy(req('/ops', WHOLE_COOKIE))

    expect(auth.getClaims).toHaveBeenCalledTimes(1)
    // getUser() is the network call this change exists to remove from the
    // per-request path. getSession() does no verification at all.
    expect(auth.getUser).not.toHaveBeenCalled()
    expect(auth.getSession).not.toHaveBeenCalled()
  })

  it('treats a token that fails local verification as unauthenticated', async () => {
    // getClaims() returns no claims when the signature or expiry does not
    // check out. That must redirect, not fall through as authenticated.
    mockAuthClient(null)

    const res = await proxy(req('/ops', WHOLE_COOKIE))

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login')
  })
})
