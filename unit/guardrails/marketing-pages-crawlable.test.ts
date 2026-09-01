import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { classifyRoute, isPrerenderedRoute } from '@/proxy'
import { readCode } from './scan'

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
  '/pricing',
  '/hosts',
  '/strops',
  '/ownerrez',
  '/hospitable',
  '/breezeway-alternative',
  '/enterprise',
  '/for-vendors',
  '/privacy',
  '/terms',
  '/dpa',
] as const

const pageFile = (route: string) =>
  join(process.cwd(), 'app', route === '/' ? '' : route.slice(1), 'page.tsx')

// Comments are stripped by ./scan's shared lexer. This file used to carry its
// own regex version, and documented its own bug with it: block comments had to
// be stripped as a whole rather than line-by-line on a `*` prefix, because a
// line-prefix filter misses the interior of a JSX comment whose lines begin
// with ordinary prose — which is exactly how the first version of the layout
// check below matched app/layout.tsx's own explanation of the call it had
// removed. That is the seventh hand-rolled lexer this suite has retired; the
// shared one also handles strings and regex literals, which the regex did not.

/**
 * Does the homepage link this route?
 *
 * Both spellings count: a JSX attribute (`href="/strops"`) and an object
 * property in a link list (`href: '/strops'`). Only the first was checked
 * initially and the assertion failed against a homepage that DID link every
 * page — the links live in a FOOTER_LINKS array, not inline in the markup.
 * The trailing quote is required so /host cannot be satisfied by /hosts.
 */
function linkedFromHomepage(homepage: string, route: string): boolean {
  return new RegExp(`href\\s*[:=]\\s*\\{?\\s*['"]${route}['"]`).test(homepage)
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
      const code = readCode(pageFile(route))
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
    // including inside a JSX comment. See readCode.
    const code = readCode(join(process.cwd(), 'app', 'layout.tsx'))

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

  // ── 4. Reachable is not the same as indexable ─────────────────────────────
  //
  // Everything above proves a crawler can FETCH these pages. None of it says
  // anything about what the crawler then reads, and on 2026-08-26 Google was
  // reporting three of them as "Crawled - currently not indexed" — fetched,
  // considered, declined.
  //
  // /privacy, /terms and /dpa each set `title` and nothing else, which cost
  // them three things at once:
  //
  //   - NO CANONICAL. Every marketing page serves 200 on BOTH fieldstay.app
  //     and app.fieldstay.app (same deployment, two aliases), so each of these
  //     existed at two identical URLs with nothing naming the real one. The
  //     www duplicate was closed with a 308 in next.config.ts; app. cannot be,
  //     because it is the session origin — the canonical tag IS the mechanism
  //     there, and these three did not have one.
  //   - A DOUBLED SUFFIX. app/layout.tsx applies `template: '%s — FieldStay'`,
  //     and the titles spelled the suffix out too, so the live SERP title read
  //     "Terms of Service — FieldStay — FieldStay".
  //   - THE FALLBACK DESCRIPTION. With none set, all three inherited the root
  //     layout's "STR operations platform for property managers." — three
  //     pages telling Google they are the same page.
  //
  // A relative canonical would not have been enough either: metadataBase is
  // NEXT_PUBLIC_APP_URL, the APP origin, so `canonical: '/terms'` resolves to
  // app.fieldstay.app and names the duplicate as the original. Hence the
  // absolute marketingUrl() check rather than merely "a canonical exists".

  const ROOT_DESCRIPTION = 'STR operations platform for property managers.'

  /**
   * Whether the page's canonical resolves to the APEX.
   *
   * One level of indirection is followed on purpose: /strops and /hosts both
   * write `const CANONICAL = marketingUrl(PATH)` and then reference it, which a
   * check demanding a literal `canonical: marketingUrl(` call reports as
   * missing. It did, on the first run of this test — a false positive against
   * two pages whose canonical is live and correct. marketingUrl() is the apex
   * helper; appUrl() and a bare relative string both resolve against the app
   * origin, and neither satisfies this.
   */
  function canonicalIsApexAbsolute(code: string): boolean {
    const m = /alternates\s*:\s*\{[^}]*canonical\s*:\s*([A-Za-z_$][\w$]*)/.exec(code)
    if (!m) return false

    const expr = m[1]!
    if (expr === 'marketingUrl') return true
    return new RegExp(`\\b(?:const|let)\\s+${expr}\\s*=\\s*marketingUrl\\s*\\(`).test(code)
  }

  it('every page sets an absolute, apex-hosted canonical', () => {
    const bad = PUBLIC_MARKETING_PAGES.filter((r) => !canonicalIsApexAbsolute(readCode(pageFile(r))))

    expect(bad, [
      'A public page has no canonical, or one that is not apex-absolute.',
      '',
      'Each of these serves 200 on BOTH fieldstay.app and app.fieldstay.app.',
      'Without `alternates: { canonical: marketingUrl(<path>) }` the two URLs are',
      'indistinguishable to Google, which then picks one itself — and a relative',
      'canonical is worse than none, because metadataBase points at the APP origin,',
      'so it names the duplicate as the original.',
    ].join('\n')).toEqual([])
  })

  it('no child-segment title repeats the brand suffix the root template already appends', () => {
    // The homepage ('/') is deliberately excluded here, and gets the OPPOSITE
    // check right below — see that test for why. Every other page in this
    // list lives one segment BELOW app/layout.tsx (app/hosts/page.tsx,
    // app/ownerrez/page.tsx, ...), which is what makes the template apply.
    const doubled = PUBLIC_MARKETING_PAGES.filter((route) => route !== '/').filter((route) => {
      const code = readCode(pageFile(route))
      const m = /title\s*:\s*'([^']*)'/.exec(code)
      return !!m && /—\s*FieldStay\s*$/.test(m[1]!)
    })

    expect(doubled, [
      "app/layout.tsx sets `template: '%s — FieldStay'`, so a page title ending in",
      '"— FieldStay" renders twice: "Terms of Service — FieldStay — FieldStay".',
      'Drop the suffix from the page and let the template add it.',
    ].join('\n')).toEqual([])
  })

  it('the homepage title spells out the brand suffix itself — the template never reaches it', () => {
    // Next.js's `title.template` (app/layout.tsx: '%s — FieldStay') applies to
    // titles from CHILD route segments only. app/page.tsx lives in the SAME
    // segment as app/layout.tsx — not a child of it — so the template never
    // applies to the homepage's own title at all, unlike every other page in
    // PUBLIC_MARKETING_PAGES (each one segment below layout.tsx).
    //
    // Verified against the real prerendered output, not just Next.js's docs:
    // a bare 'Property Ops for ...' title here (matching the OTHER pages'
    // "let the template add the suffix" convention) rendered in
    // .next/server/app/index.html as <title>Property Ops for Short-Term
    // Rental Managers</title> — no "— FieldStay" anywhere, and the earlier
    // version of this file didn't catch it because this test didn't exist yet.
    const code = readCode(pageFile('/'))
    const m = /title\s*:\s*'([^']*)'/.exec(code)

    expect(m, 'app/page.tsx should set a literal title: \'...\' string').not.toBeNull()
    expect(m![1], [
      'The homepage title must end in "— FieldStay" written out explicitly —',
      'the root template does not apply to app/page.tsx (see this test\'s header',
      'comment). Omitting it, the way every other marketing page correctly does,',
      'ships a homepage <title> with no brand name in it at all.',
    ].join('\n')).toMatch(/—\s*FieldStay\s*$/)
  })

  it('every page sets its own description, not the root fallback', () => {
    const generic = PUBLIC_MARKETING_PAGES.filter((route) => {
      const code = readCode(pageFile(route))
      return !/description\s*:/.test(code) || code.includes(ROOT_DESCRIPTION)
    })

    expect(generic, [
      'A public page has no description, so it inherits the root layout\'s',
      `"${ROOT_DESCRIPTION}" — which every other page inherits too. Three pages`,
      'carrying one description tell Google they are the same page, and that is',
      'part of what put /privacy, /terms and /dpa in "Crawled - currently not',
      'indexed". Write one that describes THIS page.',
    ].join('\n')).toEqual([])
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

  it('every one is linked from the homepage — a sitemap entry is not discovery', () => {
    // The FOURTH instance of this same GSC symptom, 2026-08-27. All six pages
    // sat at "Discovered - currently not indexed", and inspecting any returned
    // "URL is unknown to Google" / "Referring page: None detected".
    //
    // Everything machine-readable was already right: app/sitemap.ts listed the
    // apex URLs, app/robots.ts advertised the sitemap, each page served 200
    // with a correct absolute apex canonical on BOTH aliases. What was missing
    // is the thing crawlers actually weight — links. The entire homepage
    // carried two internal hrefs, /login and /signup, so every page here was an
    // orphan. /strops had been live and unlinked since 2026-08-08.
    //
    // Checked against the homepage specifically, not "anywhere in the tree":
    // being linked only from a sibling page nothing else points at leaves the
    // whole cluster orphaned together, which is the state this found.
    const homepage = readCode(
      join(process.cwd(), 'components', 'landing', 'homepage-content.tsx'),
    )

    const unlinked = PUBLIC_MARKETING_PAGES
      .filter((r) => r !== '/')
      .filter((r) => !linkedFromHomepage(homepage, r))

    expect(
      unlinked,
      'public pages with no link from the homepage — add them to FOOTER_LINKS ' +
      'in components/landing/homepage-content.tsx',
    ).toEqual([])
  })

  it('SELF-CHECK: the homepage link scan can actually fail', () => {
    // A route that is deliberately NOT in the footer. If this matches, the
    // regex above is loose enough to pass on anything and the check above is
    // decorative. Paired with the real assertion for the same reason as the
    // classification self-check below: a scan that cannot fail and a tree that
    // is clean produce identical output.
    const homepage = readCode(
      join(process.cwd(), 'components', 'landing', 'homepage-content.tsx'),
    )
    expect(linkedFromHomepage(homepage, '/no-such-marketing-page')).toBe(false)
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
