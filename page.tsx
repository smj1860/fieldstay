import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

// Routes that never require auth
const PUBLIC_ROUTES = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
]

// Routes that are token-authenticated (no Supabase session needed)
const TOKEN_ROUTES = [
  '/owner/',          // owner portal — tokenized
  '/api/work-orders', // vendor completion portal — tokenized
]

// Routes that bypass middleware entirely
const BYPASS_ROUTES = [
  '/api/inngest',          // Inngest webhook — signed
  '/api/webhooks/stripe',  // Stripe webhook — signed
  '/_next',
  '/favicon',
  '/robots',
  '/sitemap',
]

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Bypass: static assets, signed webhooks
  if (BYPASS_ROUTES.some((r) => pathname.startsWith(r))) {
    return NextResponse.next()
  }

  // Bypass: token-authenticated routes (no session needed)
  if (TOKEN_ROUTES.some((r) => pathname.startsWith(r))) {
    return NextResponse.next()
  }

  // Refresh session and get user
  const { supabaseResponse, user } = await updateSession(request)

  const isPublicRoute = PUBLIC_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(r + '/')
  )

  // Unauthenticated user hitting a protected route → login
  if (!user && !isPublicRoute) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // Authenticated user hitting auth pages → dashboard
  if (user && isPublicRoute) {
    const dashboardUrl = request.nextUrl.clone()
    dashboardUrl.pathname = '/properties'
    dashboardUrl.search = ''
    return NextResponse.redirect(dashboardUrl)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public folder files (icons, images)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
