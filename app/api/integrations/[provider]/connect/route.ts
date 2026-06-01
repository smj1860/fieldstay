/**
 * GET /api/integrations/[provider]/connect
 *
 * Step 1 of OAuth — requires the user to be authenticated.
 * Generates a CSRF state token, stores it in the DB and an httpOnly cookie,
 * then redirects to the provider's authorization URL.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createServiceClient }       from '@/lib/supabase/server'
import { getProvider }               from '@/lib/integrations/registry'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider: providerId } = await params

  const provider = getProvider(providerId)
  if (!provider) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 404 })
  }

  // Require authentication
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    const loginUrl = new URL('/login', request.nextUrl.origin)
    loginUrl.searchParams.set('next', `/api/integrations/${providerId}/connect`)
    return NextResponse.redirect(loginUrl)
  }

  // Generate CSRF state token
  const state       = crypto.randomUUID().replace(/-/g, '')
  const expiresAt   = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  // Store state in DB (service client — oauth_states has no user policies)
  const admin = createServiceClient()
  const { error } = await admin.from('oauth_states').insert({
    state,
    user_id:    user.id,
    provider_id: providerId,
    expires_at:  expiresAt,
  })

  if (error) {
    console.error('[OAuth] Failed to store state:', error.message)
    return NextResponse.json({ error: 'Failed to initiate OAuth' }, { status: 500 })
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/integrations/${providerId}/callback`
  const authUrl     = provider.getAuthorizationUrl(state, redirectUri)

  const response = NextResponse.redirect(authUrl)
  response.cookies.set('oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   600,
    path:     '/',
  })
  return response
}
