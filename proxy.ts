import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import {
  workOrderRatelimit, vendorConnectRatelimit, ownerPortalRatelimit, guidebookRatelimit,
  tokenResourceRatelimit,
  oauthCallbackRatelimit, demoRatelimit, unsubscribeRatelimit, webhookRatelimit,
  checkLimit, retryAfterSeconds,
} from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import type { Ratelimit } from '@upstash/ratelimit'

// ── Content Security Policy ────────────────────────────────────────────────
// Generated fresh per request so script-src can carry a per-request nonce
// instead of a blanket 'unsafe-inline'. Next.js stamps that nonce onto the
// inline <script>self.__next_f.push()</script> tags it uses in production to
// stream the RSC/hydration payload.
//
// It reads the nonce from the REQUEST's Content-Security-Policy header, not
// the response's — see getScriptNonceFromHeader() in
// node_modules/next/dist/server/app-render/app-render.js. This comment used to
// say "the response's CSP header", which mattered: it made the headers() call
// in app/layout.tsx look load-bearing for those 13 inline scripts, when in
// fact that call only ever nonced one <Script src=...> tag and cost the whole
// app static rendering. Verified against production HTML on 2026-08-20 (13
// inline scripts, all nonced, matching the response header's nonce).
//
// This must be the only place the app sets this header — a second static CSP
// (e.g. in next.config.ts) would make the browser enforce the *intersection*
// of both, silently dropping the nonce and reintroducing the hydration
// breakage this replaces.
function buildCsp(nonce: string | null, isDev: boolean) {
  // A PRERENDERED page's inline scripts carry no nonce and never can: the
  // HTML is built once, before any request exists, so there is nothing for
  // Next to stamp them with. Serving such a page under `'nonce-...'` blocks
  // all ~15 of its inline RSC payload scripts and the page never hydrates.
  // Measured against .next/server/app/dpa.html on 2026-08-20: 15 inline
  // script tags, 0 with a nonce. See PRERENDERED_ROUTES below.
  const inlineScripts = nonce ? `'nonce-${nonce}'` : "'unsafe-inline'"

  return [
    // Locked-down default — no blanket https: source
    "default-src 'self'",

    // Scripts: nonce (or 'unsafe-inline' on prerendered paths) covers
    // Next.js's own inline hydration scripts; wasm-unsafe-eval required by
    // the Supabase JS client. Dev mode additionally needs 'unsafe-eval' for
    // Turbopack's eval()-based module wrapping/HMR.
    isDev
      ? `script-src 'self' ${inlineScripts} 'unsafe-eval' 'wasm-unsafe-eval'`
      : `script-src 'self' ${inlineScripts} 'wasm-unsafe-eval'`,

    // Styles: 'unsafe-inline' required for the codebase's established
    // style={{ ... }} convention with CSS variables. Inline styles are CSS,
    // not JS — no code-execution XSS risk from this directive.
    "style-src 'self' 'unsafe-inline'",

    // Images: data: for base64, blob: for canvas/crop/file preview
    "img-src 'self' data: blob: https:",

    // Fonts: self + Google Fonts CDN if used
    "font-src 'self' data: https://fonts.gstatic.com",

    // Frames: Stripe hosted elements only
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",

    // Workers: blob: required for Supabase Realtime and some WASM usage
    "worker-src 'self' blob:",

    // API + WebSocket connections. Sentry ingest host added for client-side
    // error/trace reporting (instrumentation-client.ts) — without this the
    // browser SDK's own requests get silently blocked by this same CSP.
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://js.stripe.com https://auth.hospitable.com https://public.api.hospitable.com https://o4511737962364928.ingest.us.sentry.io http://localhost:* ws://localhost:* wss://localhost:*",

    // Object/media: locked down entirely
    "object-src 'none'",
    "media-src 'self'",

    // Base URI: prevent base tag injection attacks
    "base-uri 'self'",

    // Form submissions: self only
    "form-action 'self'",
  ].join('; ')
}

// ── Prerendered routes ─────────────────────────────────────────────────────
// Exactly the pages that `next build` reports as ○ (Static): pure marketing
// and legal content compiled from constants in this repo, with no dynamic API
// anywhere in their tree. Their HTML is built once and served from the CDN,
// so their inline scripts cannot carry a per-request nonce and they need the
// nonce-free CSP variant (see buildCsp).
//
// EXACT match, not prefix. `/hosts/anything` is a 404, which renders the
// dynamic not-found page — that one still gets a real nonce, and should.
//
// Two failure modes this list has, in opposite directions:
//   - a path listed here that is NOT actually prerendered gets
//     `'unsafe-inline'` for nothing: a security relaxation buying zero.
//   - a path prerendered but NOT listed here gets a nonced CSP its nonce-less
//     HTML cannot satisfy: the page renders and never hydrates.
// Both are silent in CI and invisible until a browser loads the page, which is
// why unit/guardrails/marketing-pages-crawlable.test.ts cross-checks this list
// against the page files and against app/layout.tsx staying static.
const PRERENDERED_ROUTES = new Set([
  '/',
  '/dpa',
  '/hosts',
  '/strops',
  '/ownerrez',
  '/hospitable',
  '/breezeway-alternative',
  '/pricing',
  '/enterprise',
  '/for-vendors',
  '/guarantee',
  '/privacy',
  '/terms',
])

export function isPrerenderedRoute(pathname: string): boolean {
  return PRERENDERED_ROUTES.has(pathname)
}

function withCsp(response: NextResponse, nonce: string, pathname?: string) {
  // `pathname` omitted → keep the nonce. Every redirect and throttle response
  // is generated per request and carries no prerendered HTML, so the strict
  // variant is always correct for them; defaulting the other way would hand
  // out 'unsafe-inline' on paths nobody audited.
  const effectiveNonce = pathname !== undefined && isPrerenderedRoute(pathname) ? null : nonce
  response.headers.set('Content-Security-Policy', buildCsp(effectiveNonce, process.env.NODE_ENV !== 'production'))
  return response
}

// ── Public routes ──────────────────────────────────────────────────────────
// Unauthenticated users can access these. Authenticated users are redirected
// away from most of them (except '/') to avoid showing the logged-out UI.
const PUBLIC_ROUTES = [
  '/',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/crew/accept-invite',
  '/crew/install',
  '/privacy',
  '/terms',
]

// ── Token routes ───────────────────────────────────────────────────────────
// Publicly accessible via a secure one-time token — no session required.
const TOKEN_ROUTES = [
  '/owner/',
  '/work-orders/',
  '/api/work-orders',
  '/vendor-connect/',
  '/api/vendor-connect',
  '/g/',

  // Guest/sponsor-facing guidebook API. These are POSTed to by people who by
  // definition have no FieldStay session — a sponsor arriving from a media-kit
  // email (/api/guidebook/sponsor-checkout, called from
  // app/g/kit/[media_kit_token]/media-kit-client.tsx) and a guest tapping an
  // offer (/api/guidebook/redeem, called from
  // components/guidebook/guest-guidebook-view.tsx). Listing only '/g/' here
  // covered the PAGES but not the API they call, so every such POST fell
  // through to the unauthenticated-user branch below and got a 307 to /login:
  // both flows were dead, and the inline limiters on those routes were
  // guarding endpoints no guest could reach. TOKEN_ROUTES (not BYPASS_ROUTES)
  // so the per-IP throttle below still applies.
  '/api/guidebook',

  // CAN-SPAM opt-out. Reachable without a session by legal requirement — the
  // recipient must be able to unsubscribe without logging in — so the 64-char
  // token is the only credential and this belongs in TOKEN_ROUTES (throttled),
  // not BYPASS_ROUTES. Both the human page and the RFC 8058 one-click POST
  // target are listed; a page-only entry would have left the API a 307 to
  // /login, which is exactly how /api/guidebook was silently dead.
  '/unsubscribe/',
  '/api/email/unsubscribe',

  // Owner-facing inspection report download
  // (app/api/owner/[token]/inspections/[id]/report). The owner has no session
  // by definition, so the portal token is the only credential.
  //
  // Listed SEPARATELY from '/owner/', which covers the pages and not the API —
  // exactly the gap that made every /api/guidebook POST a 307 to /login while
  // the /g/ pages calling them worked. TOKEN_ROUTES rather than BYPASS_ROUTES,
  // so the per-IP throttle still applies: this endpoint is id-keyed and
  // unauthenticated, which is the shape that most needs one.
  '/api/owner',
]

// ── Bypass routes ──────────────────────────────────────────────────────────
// Skip auth middleware entirely. These routes either handle their own auth
// or must be reachable by unauthenticated external parties.
const BYPASS_ROUTES = [
  // Uptime monitoring hits this with no session — must return the health
  // JSON (app/api/health/route.ts), not a 307 to /login. Also skips the
  // updateSession() Supabase Auth round-trip, which is the point: a health
  // check that itself depends on a live auth call defeats the purpose.
  '/api/health',

  // Team invite accept page — unauthenticated users arrive here from email links
  '/accept-invite',

  // Crew invite accept/signup page — unauthenticated crew members arrive here
  // from email links to set their password and activate their account
  '/crew-invite',

  // Internal event runners
  '/api/inngest',

  // All webhook handlers — Stripe, OwnerRez, and any future providers.
  // OwnerRez POSTs to /api/webhooks/ownerrez with Basic Auth, not a session.
  '/api/webhooks/',

  // OAuth connect and callback routes.
  // OwnerRez redirects back to /api/integrations/ownerrez/callback without
  // a FieldStay session — middleware must not intercept these.
  '/api/integrations/',

  // OwnerRez marketplace landing page.
  // Unauthenticated users arrive here from the OwnerRez marketplace.
  // Authenticated users also need to reach it to connect their account.
  // The page handles both states internally via its own auth check.
  '/ownerrez',

  // Hospitable integration landing page — same shape as /ownerrez above.
  // Logged-out visitors need to reach it directly (marketing/ads traffic),
  // and logged-in users need to reach it to connect their account. The
  // page branches its own nav CTA via its own auth check (app/hospitable/page.tsx).
  '/hospitable',

  // Offline/STR-ops marketing landing page at fieldstay.app/strops. It exists
  // to be found by search, so it MUST be reachable without a session: before
  // this entry the path fell through to the auth gate and returned
  // 307 -> /login?next=%2Fstrops, which is what a crawler would have indexed.
  // Branches its own CTA via its own auth check, same as the two above.
  '/strops',

  // Solo-host segment landing page. Same reasoning as /strops directly above,
  // and the same failure mode if it is left out: the path falls through to the
  // auth gate and returns 307 -> /login?next=%2Fhosts, so every anonymous
  // visitor bounces and the sitemap entry hands a crawler a login redirect to
  // index. Branches its own CTAs via its own auth check, like the three above.
  // No collision with '/hospitable' — these diverge at the 5th character.
  '/hosts',

  // Breezeway comparison/alternative landing page. Same reasoning and same
  // failure mode as /strops and /hosts above: it exists to rank for
  // "breezeway alternative" searches, so a 307 -> /login?next=%2Fbreezeway-alternative
  // for an anonymous crawler would defeat the entire point. No auth-branched
  // CTA, like the pages above it.
  '/breezeway-alternative',

  // Pricing, Enterprise, and Vendor-facing marketing pages — same reasoning
  // and same failure mode as every page above: exist to be found by search
  // and by direct links from other marketing pages (breezeway-alternative,
  // hosts), so a 307 -> /login for an anonymous crawler or referred visitor
  // would defeat the point. No auth-branched CTA on any of the three.
  '/pricing',
  '/enterprise',
  '/for-vendors',

  // Data Processing Agreement. BYPASS rather than PUBLIC on purpose, and the
  // distinction matters for legal documents specifically: a public route
  // bounces AUTHENTICATED users away (`user && isPublic` → redirect), so a
  // customer following a DPA link from inside the app would land on the
  // dashboard instead of the agreement. Both audiences must be able to read it.
  //
  // It was in NEITHER list, so it fell through to the auth gate and returned
  // 307 -> /login?next=%2Fdpa — verified live against production 2026-08-19.
  // That is the failure documented on /strops and /hosts above, arriving a
  // third time; it is also worse here than for a landing page, because a
  // prospect had to create an account to read the agreement they were being
  // asked to sign. Google reported it as "Discovered - currently not indexed".
  '/dpa',

  // The FieldStay Record Guarantee policy — same BYPASS reasoning as /dpa
  // immediately above: an existing customer checking the guarantee's terms
  // while signed in, and a prospect reading it before signup, both need to
  // reach the same page rather than one of them bouncing to /login or the
  // dashboard.
  '/guarantee',

  // Next.js internals and static assets
  '/_next',
  '/favicon',
  '/robots',
  '/sitemap',

  // PWA manifest and service worker — must always be served as-is.
  // The matcher below doesn't exclude .webmanifest/.js, so without this
  // bypass an unauthenticated (or transiently failing) auth refresh here
  // redirects to /login, returning HTML where the browser expects JSON —
  // surfaces as a manifest "Syntax error" in devtools.
  '/manifest.json',              // crew PWA manifest (public/manifest.json)
  '/dashboard-manifest.json',    // PM dashboard PWA manifest (public/dashboard-manifest.json)
  '/manifest.webmanifest',       // kept for forward-compatibility
  '/sw.js',

  // Service worker's offline fallback page (public/offline.html) — must be
  // reachable with no session and no network round-trip capacity to spare,
  // since it's served as the last resort when both the network and the
  // cache miss for a navigation. Same reasoning as the manifest/sw.js
  // bypasses above.
  '/offline.html',

  // Theme init script — loaded via <Script strategy="beforeInteractive">
  // in app/layout.tsx on every page, including the logged-out login page.
  // Same failure mode as manifest.json/sw.js above: without this bypass,
  // an unauthenticated request redirects to /login?next=/theme-init.js,
  // returning HTML where the browser expects JS — surfaces as the
  // "Refused to execute script... MIME type ('text/html')" console error.
  '/theme-init.js',

  // Supabase auth callback (magic links, OAuth email confirmation)
  '/auth/callback',

  // Account deletion — handles its own auth verification server-side
  '/api/account/delete',

  // Roadshow demo entry/reset — reached with NO session by definition
  // (/demo/enter exists to create one). Both routes verify DEMO_ENTRY_SECRET
  // themselves in constant time and 404 when it's unset or wrong, and both
  // are rate-limited above via rateLimiterForPathname — bypass here only
  // skips the session redirect, not the throttle.
  '/demo/',
]

// Guest-facing guidebook routes (media kit signup + guest guidebook pages,
// see TOKEN_ROUTES above) are intentionally public — guests and sponsors
// never have a FieldStay session — but still get rate-limited like every
// other token-guessable route, so they're a TOKEN_ROUTES entry, not a
// BYPASS_ROUTES one (bypass skips rate limiting entirely).

// Each guessable-token surface gets its own limiter/prefix so hammering
// one doesn't throttle another.
function rateLimiterForPathname(pathname: string) {
  if (pathname.startsWith('/work-orders/'))       return workOrderRatelimit
  if (pathname.startsWith('/api/work-orders'))    return workOrderRatelimit
  if (pathname.startsWith('/vendor-connect/'))    return vendorConnectRatelimit
  if (pathname.startsWith('/api/vendor-connect')) return vendorConnectRatelimit
  if (pathname.startsWith('/owner/'))             return ownerPortalRatelimit
  if (pathname.startsWith('/api/owner'))          return ownerPortalRatelimit
  if (pathname.startsWith('/g/'))                 return guidebookRatelimit
  if (pathname.startsWith('/api/guidebook'))      return guidebookRatelimit
  if (pathname.startsWith('/demo/'))              return demoRatelimit
  if (pathname.startsWith('/unsubscribe/'))          return unsubscribeRatelimit
  if (pathname.startsWith('/api/email/unsubscribe')) return unsubscribeRatelimit
  // OAuth callbacks are BYPASS_ROUTES (no session to check) but must still be
  // throttled — the oneclick route stores unvalidated authorization codes in
  // Vault, so the limiter check below runs BEFORE the bypass early-return.
  //
  // /connect needs the same treatment and did not have it: this matcher used
  // to require `/callback`, so /api/integrations/<provider>/connect matched no
  // branch at all. That route reaches auth.getUser() but does NOT gate on it
  // (marketplace arrivals are unauthenticated by design) and then performs a
  // service-role INSERT into oauth_states carrying a caller-supplied
  // return_to — an unauthenticated, unbounded write to the primary database.
  if (pathname.startsWith('/api/integrations/') &&
      (pathname.includes('/callback') || pathname.includes('/connect')))
    return oauthCallbackRatelimit

  // Webhooks are BYPASS_ROUTES (providers POST with their own credential, not
  // a session) and had no branch here, making them the one externally-POSTable
  // surface with no throttle at all. Their authenticity check is an APP-level
  // credential, so the payload's user_id is what decides whose integration
  // token gets revoked — one leaked secret meant unbounded mass revocation.
  // See webhookRatelimit for why the ceiling is deliberately generous.
  if (pathname.startsWith('/api/webhooks/'))      return webhookRatelimit

  return null
}

// ── Middleware classification ──────────────────────────────────────────────
// Named so both the middleware itself and
// unit/guardrails/public-route-rate-limiting.test.ts can ask the SAME question
// ("what does the middleware do with this path?") instead of the guardrail
// re-deriving the answer from the route tables. That re-derivation is what let
// H-1 through: /api/guidebook was in no table at all, and a guardrail that
// only compares two tables to each other can't see a route missing from both.
export type RouteClassification = 'bypass' | 'token' | 'public' | 'protected'

export function classifyRoute(pathname: string): RouteClassification {
  if (BYPASS_ROUTES.some((r) => pathname.startsWith(r))) return 'bypass'
  if (TOKEN_ROUTES.some((r)  => pathname.startsWith(r))) return 'token'
  if (PUBLIC_ROUTES.some((r) => pathname === r || pathname.startsWith(r + '/'))) return 'public'
  return 'protected'
}

/** True when a session-less request reaches the route instead of a 307 to /login. */
export function isReachableUnauthenticated(pathname: string): boolean {
  return classifyRoute(pathname) !== 'protected'
}

// Applies the per-IP throttle for token-guessable surfaces. Returns a 429
// response to short-circuit with, or null to continue. Runs BEFORE the bypass
// check so routes that skip auth entirely (the OAuth callbacks under
// /api/integrations/) are still throttled; bypass routes without a limiter
// entry are unaffected (rateLimiterForPathname returns null for them).
//
// Fail policy: 'allow'. These are abuse/enumeration limiters — a Redis outage
// must not take down the public work-order, owner-portal, and guidebook
// surfaces. checkLimit() also short-circuits entirely when Upstash is
// unconfigured (CI, previews, local dev without the KV addon), which is what
// keeps @upstash/redis from retrying against an undefined URL — measured at
// ~4.3s added to EVERY request on a rate-limited route, tight enough to blow
// several e2e tests' short post-mutation assertion timeouts.
async function enforceTokenRouteRateLimit(
  request:  NextRequest,
  limiter:  Ratelimit,
  nonce:    string,
): Promise<NextResponse | null> {
  // extractClientIp already prefers the platform-set headers (including
  // x-real-ip) over x-forwarded-for — this used to pass x-real-ip as a
  // FALLBACK behind a client-spoofable XFF read, which inverted the trust
  // order. The constant is the last resort: one shared bucket is the right
  // failure mode, since a per-request unique key would mean no limit at all.
  const ip = extractClientIp(request) ?? '127.0.0.1'

  // TWO buckets, both fail-open. The per-IP one bounds a single client; the
  // per-resource one bounds the token itself no matter how many clients hit
  // it. Without the second, N attacker IPs get N x the per-IP allowance
  // against one unauthenticated URL and the first limiter never fires.
  const [perIp, perResource] = await Promise.all([
    checkLimit(limiter, ip, {
      onError: 'allow',
      site:    `proxy:${request.nextUrl.pathname}`,
    }),
    checkLimit(tokenResourceRatelimit, request.nextUrl.pathname, {
      onError: 'allow',
      site:    `proxy:resource:${request.nextUrl.pathname}`,
    }),
  ])

  if (perIp.allowed && perResource.allowed) return null

  // Report the bucket that actually rejected, so Retry-After tells the caller
  // when THEY can retry rather than when the other window happens to reset.
  const decision = perIp.allowed ? perResource : perIp

  return withCsp(new NextResponse(
    JSON.stringify({ error: 'Too many requests. Please try again shortly.' }),
    {
      status:  429,
      headers: {
        'Content-Type':          'application/json',
        'X-RateLimit-Limit':     String(decision.limit),
        'X-RateLimit-Remaining': String(decision.remaining),
        'X-RateLimit-Reset':     String(decision.reset),
        'Retry-After':           String(retryAfterSeconds(decision)),
      },
    }
  ), nonce)
}

function bypassResponse(request: NextRequest, pathname: string, nonce: string): NextResponse {
  const response = withCsp(NextResponse.next({ request }), nonce, pathname)

  // Hospitable launch promo attribution — set on every /hospitable visit so
  // createCheckoutSession() can later tell a landing-page-driven signup
  // apart from a marketplace one-click connect or a manual connect. See
  // lib/inngest/functions/promo-hospitable-tag-trial.ts.
  if (pathname.startsWith('/hospitable')) {
    response.cookies.set('fs_promo_attribution', 'hospitable_landing_page', {
      maxAge:   60 * 60 * 24 * 30, // 30-day attribution window
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path:     '/',
    })
  }

  return response
}

// Authenticated user hitting a public route → redirect into the app.
// If the original destination was a crew route (carried in ?next=), honour it.
// Otherwise default to /ops (PM dashboard).
function redirectAuthenticatedAwayFromPublic(request: NextRequest, nonce: string): NextResponse {
  const url  = request.nextUrl.clone()
  const next = request.nextUrl.searchParams.get('next') ?? ''
  url.pathname = next.startsWith('/crew') ? '/crew' : '/ops'
  url.search   = ''
  return withCsp(NextResponse.redirect(url), nonce)
}

function redirectToLogin(request: NextRequest, pathname: string, nonce: string): NextResponse {
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.searchParams.set('next', pathname)
  return withCsp(NextResponse.redirect(url), nonce)
}

/** Does this request carry ANY Supabase auth cookie, chunked or not? */
function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some(
    (c) => c.name.startsWith('sb-') && c.name.includes('-auth-token')
  )
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  // Forwarded as a request header so Next.js's own script-tag rendering
  // (and any Server Component that wants it) can read it via headers().
  request.headers.set('x-nonce', nonce)

  const tokenRouteLimiter = rateLimiterForPathname(pathname)
  if (tokenRouteLimiter) {
    const throttled = await enforceTokenRouteRateLimit(request, tokenRouteLimiter, nonce)
    if (throttled) return throttled
  }

  const classification = classifyRoute(pathname)

  if (classification === 'bypass') return bypassResponse(request, pathname, nonce)
  if (classification === 'token')  return withCsp(NextResponse.next({ request }), nonce, pathname)

  const isPublic = classification === 'public'

  // ANONYMOUS TRAFFIC PAYS NOTHING.
  //
  // updateSession() runs Supabase Auth below, and it used to run before this
  // check — so a visitor with no session at all, landing on /, /login, /signup
  // or /forgot-password, still triggered auth work on every page view. That
  // made the entire public-facing site depend on Supabase Auth's availability
  // and latency, for a request that by definition has no session to validate.
  //
  // A request with no session cookie cannot be authenticated, so there is
  // nothing for updateSession() to refresh and nothing for the two redirects
  // below to act on: `!user && isPublic` is a no-op, and `user && isPublic`
  // cannot be true. Skipping is exactly equivalent, minus the work.
  //
  // Substring, not endsWith: @supabase/ssr CHUNKS a large session across
  // `sb-<ref>-auth-token.0`, `.1`, … so an endsWith('-auth-token') test —
  // which is what the obvious version of this looks like — silently classifies
  // the users with the biggest sessions as anonymous, and stops redirecting
  // them away from /login.
  if (isPublic && !hasSessionCookie(request)) {
    return withCsp(NextResponse.next({ request }), nonce, pathname)
  }

  const { supabaseResponse, user } = await updateSession(request)

  // Unauthenticated user hitting a protected route → redirect to login
  if (!user && !isPublic) return redirectToLogin(request, pathname, nonce)

  if (user && isPublic && pathname !== '/') return redirectAuthenticatedAwayFromPublic(request, nonce)

  supabaseResponse.headers.set('x-pathname', pathname)

  return withCsp(supabaseResponse, nonce, pathname)
}

/**
 * Which requests run this middleware at all.
 *
 * The old pattern excluded `_next/static`, `_next/image`, `favicon.ico` and a
 * fixed IMAGE extension list — so every other static file under /public had to
 * be enumerated by hand in BYPASS_ROUTES (`/manifest.json`,
 * `/dashboard-manifest.json`, `/sw.js`, `/theme-init.js`, `/offline.html`, …).
 * Today's tree happens to be fully covered, but the safety net was "someone
 * remembers to add a line". A missed entry means that asset pays the full
 * session resolution on every request — and, for an anonymous fetch, a 307 to
 * /login instead of the file.
 *
 * `[^/]+\.[a-zA-Z0-9]+$` replaces the allowlist with a structural rule: a
 * ROOT-LEVEL path with a file extension is a static asset. Every current and
 * future /public file is exempt with no per-file entry, which is the actual
 * finding (P3-6).
 *
 * ── Why root-level, and not the audit's `.*\.(js|json|css|…)$` ─────────────
 *
 * Because middleware is where TOKEN-ROUTE RATE LIMITING lives
 * (rateLimiterForPathname, applied at the top of proxy()). An unanchored
 * extension exclusion also matches a dynamic segment that happens to end in
 * one — `/vendor-connect/<token>.map` would skip middleware entirely and
 * therefore skip its throttle, on exactly the enumeration-prone surfaces that
 * throttle exists to protect.
 *
 * Every token route is NESTED (`/owner/…`, `/work-orders/…`, `/g/b/…`,
 * `/vendor-connect/…`), and every /public file here is FLAT, so anchoring the
 * extension test to a single root segment separates them cleanly. Tokens are
 * crypto.randomUUID() and contain no dots today — this does not depend on that
 * staying true, which is the point.
 *
 * The nested image exclusion is kept as-is: images may legitimately live in
 * subdirectories, and they are never a token route.
 *
 * BYPASS_ROUTES keeps its static entries. They are now unreachable rather than
 * load-bearing, and that is deliberate defence in depth — if this pattern is
 * ever narrowed, the allowlist is what stops those files 307ing to /login.
 * unit/lib/proxy-matcher.test.ts is what stops the pattern being narrowed
 * silently.
 */
// The literal is INLINE, and must stay inline. Next.js statically parses this
// object at build time and rejects anything it cannot read without evaluating:
//
//   Next.js can't recognize the exported `config` field in route.
//   Entry `matcher[0]` need to be static strings or static objects.
//
// A `const MIDDLEWARE_MATCHER = '…'` referenced here type-checks, lints,
// passes every unit test and every semgrep gate, and then fails `next build`.
// Nothing in the local verification pass runs a build, so this is invisible
// until CI — the same class as the 'use server' export rule that
// unit/guardrails/use-server-exports.test.ts exists for, and now guarded the
// same way by unit/guardrails/next-static-config.test.ts.
//
// Tests read `config.matcher[0]` rather than a second copy of the pattern, so
// there is exactly one source of truth.
export const config = {
  matcher: ['/((?!_next/static|_next/image|[^/]+\\.[a-zA-Z0-9]+$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
