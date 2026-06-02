import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

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
]

// ── Token routes ───────────────────────────────────────────────────────────
// Publicly accessible via a secure one-time token — no session required.
const TOKEN_ROUTES = [
  '/owner/',
  '/work-orders/',
  '/api/work-orders',
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

  // Supabase auth callback (magic links, OAuth email confirmation)
  '/auth/callback',
]

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (BYPASS_ROUTES.some((r) => pathname.startsWith(r))) return NextResponse.next()
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

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
