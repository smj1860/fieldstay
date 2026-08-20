import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ============================================================================
// THE NONCE-FREE CSP REACHES THE EIGHT PRERENDERED PATHS AND NOTHING ELSE.
//
// Added with the 2026-08-20 prerender change. proxy.ts now emits two CSP
// variants: `script-src 'self' 'nonce-...'` everywhere, and a nonce-free
// `script-src 'self' 'unsafe-inline'` on the paths whose HTML is built before
// any request exists and therefore cannot carry a nonce.
//
// Both directions of that split are silent when wrong, which is the entire
// reason this file exists:
//
//   - too NARROW → a prerendered page is served a nonced CSP its nonce-less
//     HTML cannot satisfy. All ~15 inline RSC scripts are blocked. The page
//     renders, looks correct to a crawler and to a screenshot, and never
//     hydrates. No test fails.
//   - too WIDE → an app route gets 'unsafe-inline'. Nothing breaks, nothing
//     is logged, and the CSP protecting the session-bearing origin is
//     quietly weakened. No test fails.
//
// The second one is why /maintenance and /ops are asserted here by name. When
// CI went red on this change it was reasonable to suspect a CSP regression on
// a dashboard route had broken hydration, and the answer at the time came
// from reading the code. Reading is not a check.
// ============================================================================

const updateSessionMock = vi.fn()
vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: (...a: unknown[]) => updateSessionMock(...a),
}))

// Every limiter short-circuits to `skipped` without Upstash configured, which
// is what the unit environment already looks like. Stubbed anyway so a token
// route's throttle branch cannot reach the network.
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>()
  return {
    ...actual,
    checkLimit: vi.fn().mockResolvedValue({ success: true, skipped: true, errored: false }),
  }
})

async function respond(pathname: string) {
  const { proxy } = await import('@/proxy')
  return proxy(new NextRequest(`https://fieldstay.app${pathname}`))
}

async function cspFor(pathname: string): Promise<string> {
  return (await respond(pathname)).headers.get('Content-Security-Policy') ?? ''
}

const scriptSrc = (csp: string) =>
  csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) ?? ''

/** Every path `next build` reports as ○ (Static) and that serves HTML. */
const PRERENDERED = ['/', '/dpa', '/hosts', '/strops', '/ownerrez', '/hospitable', '/privacy', '/terms']

/**
 * Routes that render per request. A nonce is both possible and required.
 *
 * Every one is PROTECTED or a TOKEN route, so with a session present each
 * reaches the branch of proxy() that actually serves the page. That matters:
 * the first version of this list included /login and ran anonymously, so
 * every entry was answered by a 307 to /login whose CSP is built WITHOUT a
 * pathname and therefore always keeps its nonce. The check passed while
 * measuring redirects, and a deliberately-wrong PRERENDERED_ROUTES entry did
 * not make it fail. The status assertion below is what stops that recurring.
 */
const DYNAMIC = ['/ops', '/maintenance', '/turnovers', '/settings/team', '/crew', '/owner/some-token']

describe('proxy CSP: nonce vs unsafe-inline', () => {
  beforeEach(async () => {
    const { NextResponse } = await import('next/server')
    // mockImplementation, NOT mockResolvedValue. The latter builds ONE
    // NextResponse in this hook and hands the same object to every call, so
    // two concurrent requests write their CSP headers to the same instance
    // and the second silently overwrites the first — which made the
    // fresh-nonce assertion below fail against a proxy.ts that was correct.
    // Every request gets its own response object, as in production.
    updateSessionMock.mockImplementation(async () => ({
      supabaseResponse: NextResponse.next(),
      user: { id: '00000000-0000-4000-8000-000000000001' },
    }))
  })
  afterEach(() => vi.clearAllMocks())

  it.each(PRERENDERED)('%s gets unsafe-inline and NO nonce', async (path) => {
    const src = scriptSrc(await cspFor(path))

    expect(src, `${path} is prerendered — a nonce it cannot carry blocks every inline script`)
      .toContain("'unsafe-inline'")
    expect(src, `${path} must not be handed a nonce`).not.toMatch(/'nonce-/)
  })

  it.each(DYNAMIC)('%s keeps its nonce and never gets unsafe-inline', async (path) => {
    // Answered as an authenticated visitor (see the updateSession mock), so
    // every path here reaches the branch that serves the page.
    const res = await respond(path)

    // The response must be the PAGE, not a redirect. A 307 to /login carries
    // a nonce unconditionally, so without this the assertion below is
    // satisfied by a response that never consulted PRERENDERED_ROUTES at all —
    // which is exactly how the first version of this file passed while
    // /maintenance was deliberately mis-listed as prerendered.
    expect(res.status, `${path} answered ${res.status} — this is measuring a redirect, not the page`)
      .not.toBe(307)

    const src = scriptSrc(res.headers.get('Content-Security-Policy') ?? '')

    expect(src, [
      `${path} lost its nonce.`,
      '',
      'This is a server-rendered route on the origin that holds the session',
      'cookie. Relaxing script-src here buys nothing — the HTML is built per',
      'request and can carry a nonce — and costs the only defence the CSP',
      'provides against an injected inline script.',
    ].join('\n')).toMatch(/'nonce-/)

    expect(src, `${path} was handed 'unsafe-inline'`).not.toContain("'unsafe-inline'")
  })

  it('the nonce is fresh per request', async () => {
    // A reused nonce is worth no more than 'unsafe-inline'.
    const [a, b] = await Promise.all([cspFor('/ops'), cspFor('/ops')])
    const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1]

    expect(nonceOf(a)).toBeTruthy()
    expect(nonceOf(a)).not.toBe(nonceOf(b))
  })

  it('SELF-CHECK: the two sets are disjoint and both non-empty', () => {
    // A scan over an empty list passes. So does one whose sets overlap and
    // therefore contradict each other.
    expect(PRERENDERED.length).toBeGreaterThan(0)
    expect(DYNAMIC.length).toBeGreaterThan(0)
    expect(PRERENDERED.filter((p) => DYNAMIC.includes(p))).toEqual([])
  })
})
