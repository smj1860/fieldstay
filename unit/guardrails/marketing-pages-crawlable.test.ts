import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { classifyRoute, isPrerenderedRoute } from '@/proxy'

// ============================================================================
// EVERY PUBLIC MARKETING AND LEGAL PAGE MUST BE ANONYMOUSLY REACHABLE, AND
// MUST RENDER WITHOUT AN AUTH ROUND TRIP.
//
// Two defects, both found 2026-08-19 from a Google Search Console report of
// seven URLs stuck at "Discovered - currently not indexed / Last crawled: N/A".
//
// ── 1. A page in NEITHER route table falls through to the auth gate ─────────
//
// /dpa was in neither PUBLIC_ROUTES nor BYPASS_ROUTES, so it returned
// 307 -> /login?next=%2Fdpa. Verified live against production. A crawler
// cannot index a login redirect — and worse than the SEO cost, a prospect had
// to create an account to read the Data Processing Agreement they were being
// asked to sign.
//
// This was the THIRD time: proxy.ts already carries comments describing the
// identical failure for /strops and /hosts. Prose did not stop it recurring,
// so this is the check.
//
// ── 2. An auth call in the page body makes it dynamic and unreliable ────────
//
// /hosts, /strops, /ownerrez and /hospitable each called cookies() +
// supabase.auth.getUser() to swap a CTA label. cookies() forces dynamic
// rendering — no static generation, no CDN cache, a cold server render on
// every crawl — and getUser() is a network round trip to Supabase Auth with no
// timeout.
//
// Measured: those pages intermittently failed to respond AT ALL (connection
// hang to timeout; /hosts on 3 of 8 requests) while example.com, google.com
// and vercel.com were 12 of 12 clean. That unreliability is what makes Google
// throttle a host and leave URLs discovered-but-uncrawled.
//
// The branch was redundant anyway: proxy.ts already redirects an authenticated
// visitor away from /login and /signup to /ops.
// ============================================================================

/**
 * Pages that exist to be found by search engines and read by strangers.
 *
 * Grow this list when a marketing or legal page is added — that is the point.
 * A page here must be reachable with no session AND must not do auth work to
 * render.
 */
const PUBLIC_MARKETING_PAGES = [
  '/',
  '/hosts',
  '/strops',
  '/ownerrez',
  '/hospitable',
  '/privacy',
  '/terms',
  '/dpa',
] as const

const pageFile = (route: string) =>
  join(process.cwd(), 'app', route === '/' ? '' : route.slice(1), 'page.tsx')

/**
 * Source with its comments removed, so a scan cannot read an explanation as a
 * live call site.
 *
 * Block comments are stripped FIRST and as a whole, not line-by-line on a `*`
 * prefix. A line-prefix filter misses the interior of a `{/* ... *\/}` JSX
 * comment, whose lines begin with ordinary prose — which is precisely how the
 * first version of the layout check below failed: app/layout.tsx explains, in
 * a JSX comment, that the removed `nonce` prop "cost a headers() call", and
 * the scan matched its own documentation.
 *
 * `//` is only honoured at the start of a trimmed line, so a URL keeps its
 * scheme.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

describe('guardrail: public marketing and legal pages are crawlable', () => {
  it('every one has a page file — the list cannot rot into naming pages that do not exist', () => {
    const missing = PUBLIC_MARKETING_PAGES.filter((r) => !existsSync(pageFile(r)))
    expect(missing, 'listed routes with no app/<route>/page.tsx').toEqual([])
  })

  it('none falls through to the auth gate', () => {
    // classifyRoute is the same function the middleware calls, so this asserts
    // the real behaviour rather than re-deriving it from the tables — which is
    // exactly how /dpa slipped through: it was absent from both.
    const gated = PUBLIC_MARKETING_PAGES
      .map((route) => ({ route, classification: classifyRoute(route) }))
      .filter(({ classification }) => classification === 'protected')
      .map(({ route }) => route)

    expect(gated, [
      'A public page is classified `protected`, so an anonymous visitor gets',
      '307 -> /login?next=<page> and a crawler indexes a login redirect.',
      '',
      'Add it to BYPASS_ROUTES in proxy.ts.',
      '',
      'BYPASS rather than PUBLIC for anything a LOGGED-IN user must also read —',
      'legal documents especially. A public route bounces authenticated users',
      'away (`user && isPublic` -> redirect to /ops), so a customer following a',
      'DPA link from inside the app would land on the dashboard instead.',
    ].join('\n')).toEqual([])
  })

  it('none does auth work at request time', () => {
    // A single cookies() call forces dynamic rendering, so the page can never
    // be statically generated or CDN-cached no matter what else is done to it.
    const dynamic = PUBLIC_MARKETING_PAGES.filter((route) => {
      // Comments stripped: these files now DOCUMENT the removed call, and a
      // naive scan reads that prose as a live call site — the trap that has
      // already made two guardrails in this directory fail on the very change
      // that fixed them, and that this file's own layout check hit again.
      const code = stripComments(readFileSync(pageFile(route), 'utf8'))
      return /auth\.getUser\s*\(/.test(code) || /\bcookies\s*\(\s*\)/.test(code)
    })

    expect(dynamic, [
      'A public marketing page calls cookies() or auth.getUser() at request time.',
      '',
      'That forces dynamic rendering — no static generation, no CDN cache, a cold',
      'server render on every crawl — and adds an untimed network round trip to',
      'Supabase Auth on a page whose whole purpose is to be fetched by strangers.',
      'For a crawler the answer is always "no user".',
      '',
      'Swapping a CTA for logged-in visitors is NOT a reason: proxy.ts already',
      'redirects an authenticated visitor away from /login and /signup to /ops,',
      'so the logged-out CTA lands them in the app regardless.',
    ].join('\n')).toEqual([])
  })

  // ── 3. Prerendering, and the CSP that depends on it ───────────────────────
  //
  // Added 2026-08-20. The two fixes above stopped the pages doing auth work,
  // but a build proved every route in the app was still `ƒ (Dynamic)` and
  // returning `cache-control: private, no-cache, no-store` — because
  // app/layout.tsx carried BOTH `export const dynamic = 'force-dynamic'` and
  // an `await headers()` call, either of which forces the whole subtree
  // dynamic. A child cannot opt back in: `export const dynamic =
  // 'force-static'` on app/dpa/page.tsx was tried against a real build and
  // the route stayed ƒ.
  //
  // Removing both makes exactly these pages prerender. That in turn REQUIRES
  // proxy.ts to serve them a nonce-free CSP, because prerendered HTML's
  // inline RSC scripts carry no nonce (measured: .next/server/app/dpa.html
  // has 15 inline script tags, 0 nonced) and a nonced CSP blocks all of them.
  //
  // The two halves are a matched pair, and breaking either one alone is
  // SILENT — CI stays green, and you find out from a browser console or from
  // a response header nobody checks. So both are asserted here.

  it('the root layout stays static — the thing that makes prerendering possible', () => {
    // Comments stripped: this file DOCUMENTS both removed calls at length,
    // including inside a JSX comment. See stripComments.
    const code = stripComments(readFileSync(join(process.cwd(), 'app', 'layout.tsx'), 'utf8'))

    expect(code, [
      'app/layout.tsx sets `dynamic` again.',
      '',
      'Segment config on the ROOT layout applies to every route in the app, and',
      'a child cannot override it. This single line turns all eight prerendered',
      'marketing pages back into per-request server renders -- and worse than',
      'undoing the win, it makes proxy.ts\'s `unsafe-inline` CSP for those paths',
      'a pure security relaxation buying nothing at all.',
    ].join('\n')).not.toMatch(/export\s+const\s+dynamic\s*=/)

    expect(code, [
      'app/layout.tsx uses a dynamic API (headers/cookies/draftMode).',
      '',
      'Same blast radius as `dynamic` above: one call in the root layout makes',
      'every route in the app dynamic.',
      '',
      'If this is back for the CSP nonce, it is not needed. Next.js reads the',
      'nonce itself from the REQUEST Content-Security-Policy header --',
      'getScriptNonceFromHeader() in next/dist/server/app-render/app-render.js',
      '-- and stamps its own inline scripts without any help from this file.',
    ].join('\n')).not.toMatch(/\b(headers|cookies|draftMode)\s*\(\s*\)/)
  })

  it('every page that prerenders is in proxy.ts PRERENDERED_ROUTES', () => {
    const missing = PUBLIC_MARKETING_PAGES.filter((route) => !isPrerenderedRoute(route))

    expect(missing, [
      'A prerendered marketing page is missing from PRERENDERED_ROUTES in proxy.ts.',
      '',
      'It will be served a CSP carrying a per-request nonce, while its HTML was',
      'built long before the request and carries no nonce on any of its ~15',
      'inline RSC scripts. Every one is blocked: the page renders, looks fine to',
      'a crawler, and never hydrates. Nothing in CI sees this.',
    ].join('\n')).toEqual([])
  })

  it('SELF-CHECK: the classification scan can actually fail', () => {
    // A guardrail at zero because it is blind looks identical to one at zero
    // because the tree is clean. Two checks in this directory have already been
    // in the first state.
    expect(classifyRoute('/dpa')).not.toBe('protected')      // the page this fixed
    expect(classifyRoute('/ops')).toBe('protected')          // a genuinely gated route
    expect(classifyRoute('/turnovers')).toBe('protected')
  })
})
