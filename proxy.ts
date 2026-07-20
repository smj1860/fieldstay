import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import {
  workOrderRatelimit, vendorConnectRatelimit, ownerPortalRatelimit, guidebookRatelimit,
} from '@/lib/rate-limit'

// ── Content Security Policy ────────────────────────────────────────────────
// Generated fresh per request so script-src can carry a per-request nonce
// instead of a blanket 'unsafe-inline' — Next.js automatically stamps that
// nonce onto the inline <script>self.__next_f.push()</script> tags it uses
// in production to stream the RSC/hydration payload, once it sees a
// 'nonce-...' source in the response's CSP header. This must be the only
// place the app sets this header — a second static CSP (e.g. in
// next.config.ts) would make the browser enforce the *intersection* of both,
// silently dropping the nonce and reintroducing the hydration breakage this
// replaces.
function buildCsp(nonce: string, isDev: boolean) {
  return [
    // Locked-down default — no blanket https: source
    "default-src 'self'",

    // Scripts: nonce covers Next.js's own inline hydration scripts;
    // wasm-unsafe-eval required by Supabase JS client. Dev mode additionally
    // needs 'unsafe-eval' for Turbopack's eval()-based module wrapping/HMR.
    isDev
      ? `script-src 'self' 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval'`
      : `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,

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

function withCsp(response: NextResponse, nonce: string) {
  response.headers.set('Content-Security-Policy', buildCsp(nonce, process.env.NODE_ENV !== 'production'))
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
  '/wo/',
  '/vendor-connect/',
  '/api/vendor-connect',
  '/g/',
]

// ── Bypass routes ──────────────────────────────────────────────────────────
// Skip auth middleware entirely. These routes either handle their own auth
// or must be reachable by unauthenticated external parties.
const BYPASS_ROUTES = [
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
]

// Guest-facing guidebook routes (media kit signup + guest guidebook pages,
// see TOKEN_ROUTES above) are intentionally public — guests and sponsors
// never have a FieldStay session — but still get rate-limited like every
// other token-guessable route, so they're a TOKEN_ROUTES entry, not a
// BYPASS_ROUTES one (bypass skips rate limiting entirely).

// Each guessable-token surface gets its own limiter/prefix so hammering
// one doesn't throttle another.
function rateLimiterForPathname(pathname: string) {
  if (pathname.startsWith('/wo/'))               return workOrderRatelimit
  if (pathname.startsWith('/work-orders/'))       return workOrderRatelimit
  if (pathname.startsWith('/api/work-orders'))    return workOrderRatelimit
  if (pathname.startsWith('/vendor-connect/'))    return vendorConnectRatelimit
  if (pathname.startsWith('/api/vendor-connect')) return vendorConnectRatelimit
  if (pathname.startsWith('/owner/'))             return ownerPortalRatelimit
  if (pathname.startsWith('/g/'))                 return guidebookRatelimit
  return null
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  // Forwarded as a request header so Next.js's own script-tag rendering
  // (and any Server Component that wants it) can read it via headers().
  request.headers.set('x-nonce', nonce)

  if (BYPASS_ROUTES.some((r) => pathname.startsWith(r))) return withCsp(NextResponse.next({ request }), nonce)

  // Rate limit unauthenticated token-guessable routes — guards against
  // token enumeration and request flooding.
  const tokenRouteLimiter = rateLimiterForPathname(pathname)

  if (tokenRouteLimiter) {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      '127.0.0.1'

    try {
      const { success, limit, remaining, reset } =
        await tokenRouteLimiter.limit(ip)

      if (!success) {
        return withCsp(new NextResponse(
          JSON.stringify({ error: 'Too many requests. Please try again shortly.' }),
          {
            status:  429,
            headers: {
              'Content-Type':  'application/json',
              'X-RateLimit-Limit':     String(limit),
              'X-RateLimit-Remaining': String(remaining),
              'X-RateLimit-Reset':     String(reset),
              'Retry-After':           String(Math.ceil((reset - Date.now()) / 1000)),
            },
          }
        ), nonce)
      }
    } catch (err) {
      // If Redis is unavailable, fail open — don't take down these public
      // routes over an infrastructure issue
      console.error('[proxy] rate limit check failed', err)
    }
  }

  if (TOKEN_ROUTES.some((r)  => pathname.startsWith(r)))  return withCsp(NextResponse.next({ request }), nonce)

  const { supabaseResponse, user } = await updateSession(request)

  const isPublic = PUBLIC_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(r + '/')
  )

  // Unauthenticated user hitting a protected route → redirect to login
  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return withCsp(NextResponse.redirect(url), nonce)
  }

  // Authenticated user hitting a public route → redirect into the app.
  // If the original destination was a crew route (carried in ?next=), honour it.
  // Otherwise default to /ops (PM dashboard).
  if (user && isPublic && pathname !== '/') {
    const url = request.nextUrl.clone()
    const next = request.nextUrl.searchParams.get('next') ?? ''
    url.pathname = next.startsWith('/crew') ? '/crew' : '/ops'
    url.search   = ''
    return withCsp(NextResponse.redirect(url), nonce)
  }

  supabaseResponse.headers.set('x-pathname', pathname)

  return withCsp(supabaseResponse, nonce)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
