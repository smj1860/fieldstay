import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(),
}))

import { createServerClient } from '@supabase/ssr'
import { updateSession } from '@/lib/supabase/middleware'

type CookieToSet = { name: string; value: string; options?: Record<string, unknown> }

interface CapturedCookieConfig {
  getAll: () => { name: string; value: string }[]
  setAll: (cookies: CookieToSet[]) => void
}

/**
 * Captures the { cookies: { getAll, setAll } } config createServerClient was
 * invoked with, so tests can drive it directly the way the real @supabase/ssr
 * client would (calling getAll to read the incoming request, calling setAll
 * to write refreshed session cookies).
 */
function mockSupabaseClient(opts: { user: { id: string } | null; refreshedCookies?: CookieToSet[] }) {
  let capturedCookies: CapturedCookieConfig | undefined

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createServerClient).mockImplementation((_url: any, _key: any, config: any) => {
    capturedCookies = config.cookies
    return {
      auth: {
        getUser: vi.fn(async () => {
          // Simulate @supabase/ssr rewriting cookies mid-call when the
          // session token gets refreshed, exactly like the real client does.
          if (opts.refreshedCookies) {
            capturedCookies?.setAll(opts.refreshedCookies)
          }
          return { data: { user: opts.user } }
        }),
        // getSession must never be called by this module — see assertions below.
        getSession: vi.fn(async () => {
          throw new Error('getSession should never be called — use getUser()')
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  })

  return () => capturedCookies
}

const SUPABASE_URL = 'https://unit-test.invalid'
const SUPABASE_ANON_KEY = 'unit-test-anon-key'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = SUPABASE_ANON_KEY
})

describe('updateSession', () => {
  it('constructs the Supabase server client with the public URL and anon key (never the service role key)', async () => {
    mockSupabaseClient({ user: null })
    const request = new NextRequest('https://app.fieldstay.test/ops')

    await updateSession(request)

    expect(createServerClient).toHaveBeenCalledWith(
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
      expect.objectContaining({ cookies: expect.any(Object) }),
    )
  })

  it('calls auth.getUser() to validate the session, not getSession()', async () => {
    const getCookies = mockSupabaseClient({ user: { id: 'user_1' } })
    const request = new NextRequest('https://app.fieldstay.test/ops')

    await updateSession(request)

    const client = vi.mocked(createServerClient).mock.results[0].value
    expect(client.auth.getUser).toHaveBeenCalledTimes(1)
    expect(client.auth.getSession).not.toHaveBeenCalled()
    expect(getCookies()).toBeDefined()
  })

  it('returns the authenticated user from getUser()', async () => {
    mockSupabaseClient({ user: { id: 'user_42' } })
    const request = new NextRequest('https://app.fieldstay.test/ops')

    const { user } = await updateSession(request)

    expect(user).toEqual({ id: 'user_42' })
  })

  it('returns a null user when there is no session', async () => {
    mockSupabaseClient({ user: null })
    const request = new NextRequest('https://app.fieldstay.test/ops')

    const { user } = await updateSession(request)

    expect(user).toBeNull()
  })

  it('always returns a NextResponse, even with no cookie refresh', async () => {
    mockSupabaseClient({ user: null })
    const request = new NextRequest('https://app.fieldstay.test/ops')

    const { supabaseResponse } = await updateSession(request)

    expect(supabaseResponse).toBeDefined()
    expect(typeof supabaseResponse.cookies.getAll).toBe('function')
  })

  it("cookies.getAll() proxies to the incoming request's cookies", async () => {
    const getCookies = mockSupabaseClient({ user: null })
    const request = new NextRequest('https://app.fieldstay.test/ops', {
      headers: { cookie: 'sb-access-token=abc123; other-cookie=xyz' },
    })

    await updateSession(request)

    const seen = getCookies()!.getAll()
    expect(seen).toEqual(
      expect.arrayContaining([
        { name: 'sb-access-token', value: 'abc123' },
        { name: 'other-cookie', value: 'xyz' },
      ]),
    )
  })

  it('propagates a refreshed session cookie onto the returned response', async () => {
    mockSupabaseClient({
      user: { id: 'user_1' },
      refreshedCookies: [
        { name: 'sb-access-token', value: 'refreshed-token', options: { path: '/', httpOnly: true } },
      ],
    })
    const request = new NextRequest('https://app.fieldstay.test/ops', {
      headers: { cookie: 'sb-access-token=stale-token' },
    })

    const { supabaseResponse } = await updateSession(request)

    const cookie = supabaseResponse.cookies.get('sb-access-token')
    expect(cookie?.value).toBe('refreshed-token')
  })

  it('writes a refreshed cookie onto the request cookies too, not just the response', async () => {
    const getCookies = mockSupabaseClient({
      user: { id: 'user_1' },
      refreshedCookies: [{ name: 'sb-access-token', value: 'refreshed-token' }],
    })
    const request = new NextRequest('https://app.fieldstay.test/ops', {
      headers: { cookie: 'sb-access-token=stale-token' },
    })

    await updateSession(request)

    expect(request.cookies.get('sb-access-token')?.value).toBe('refreshed-token')
    // getAll() reflects the mutated request state if read again afterward.
    const seen = getCookies()!.getAll()
    expect(seen.find((c) => c.name === 'sb-access-token')?.value).toBe('refreshed-token')
  })

  it('propagates multiple refreshed cookies onto the response (e.g. access + refresh token pair)', async () => {
    mockSupabaseClient({
      user: { id: 'user_1' },
      refreshedCookies: [
        { name: 'sb-access-token', value: 'new-access' },
        { name: 'sb-refresh-token', value: 'new-refresh' },
      ],
    })
    const request = new NextRequest('https://app.fieldstay.test/ops')

    const { supabaseResponse } = await updateSession(request)

    expect(supabaseResponse.cookies.get('sb-access-token')?.value).toBe('new-access')
    expect(supabaseResponse.cookies.get('sb-refresh-token')?.value).toBe('new-refresh')
  })

  it('never leaks the Supabase service role key when constructing the client', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'super-secret-service-role-key'
    mockSupabaseClient({ user: null })
    const request = new NextRequest('https://app.fieldstay.test/ops')

    await updateSession(request)

    const [, key] = vi.mocked(createServerClient).mock.calls[0]
    expect(key).toBe(SUPABASE_ANON_KEY)
    expect(key).not.toContain('super-secret-service-role-key')
  })
})
