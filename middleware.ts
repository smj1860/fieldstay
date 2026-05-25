import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

const PUBLIC_ROUTES  = ['/login', '/signup', '/forgot-password', '/reset-password', '/crew/accept-invite']
const TOKEN_ROUTES   = ['/owner/', '/work-orders/', '/api/work-orders']
const BYPASS_ROUTES  = ['/api/inngest', '/api/webhooks/stripe', '/_next', '/favicon', '/robots', '/sitemap']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (BYPASS_ROUTES.some((r) => pathname.startsWith(r))) return NextResponse.next()
  if (TOKEN_ROUTES.some((r)  => pathname.startsWith(r)))  return NextResponse.next()

  const { supabaseResponse, user } = await updateSession(request)

  const isPublic = PUBLIC_ROUTES.some((r) => pathname === r || pathname.startsWith(r + '/'))

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  if (user && isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/properties'
    url.search   = ''
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
