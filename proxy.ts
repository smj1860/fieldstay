import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { workOrderRatelimit } from '@/lib/rate-limit'

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
]

// ── Bypass routes ──────────────────────────────────────────────────────────
// Skip auth middleware entirely. These routes either handle their own auth
// or must be reachable by unauthenticated external parties.
const BYPASS_ROUTES = [
  // Team invite accept page — unauthenticated users arrive here from email links
  '/accept-invite',

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

  // Supabase auth callback (magic links, OAuth email confirmation)
  '/auth/callback',

  // Account deletion — handles its own auth verification server-side
  '/api/account/delete',
]

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (BYPASS_ROUTES.some((r) => pathname.startsWith(r))) return NextResponse.next()

  // Rate limit the public work order page — guards against token
  // enumeration and request flooding on this unauthenticated route.
  if (pathname.startsWith('/wo/')) {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      '127.0.0.1'

    try {
      const { success, limit, remaining, reset } =
        await workOrderRatelimit.limit(ip)

      if (!success) {
        return new NextResponse(
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
        )
      }
    } catch (err) {
      // If Redis is unavailable, fail open — don't take down the public
      // work order page over an infrastructure issue
      console.error('[proxy] rate limit check failed', err)
    }
  }

  if (TOKEN_ROUTES.some((r)  => pathname.startsWith(r)))  return NextResponse.next()

  const { supabaseResponse, user } = await updateSession(request)

  const isPublic = PUBLIC_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(r + '/')
  )

  // Unauthenticated user hitting a protected route → redirect to login
  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  // Authenticated user hitting a public route → redirect into the app
  // (except '/' which doubles as the marketing homepage)
  if (user && isPublic && pathname !== '/') {
    const url = request.nextUrl.clone()
    url.pathname = '/ops'
    url.search   = ''
    return NextResponse.redirect(url)
  }

  supabaseResponse.headers.set('x-pathname', pathname)
  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
