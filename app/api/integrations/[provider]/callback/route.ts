/**
 * GET /api/integrations/[provider]/callback
 *
 * Steps 2–3 of OAuth:
 *  2. Validate CSRF state against cookie + DB
 *  3. Exchange temporary code for access token
 *  4. Store token in Vault
 *  5. Create/update integration_connections row
 *  6. Dispatch integration/ownerrez.connected Inngest event
 *  7. Redirect to /settings/integrations
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createServiceClient }       from '@/lib/supabase/server'
import { getProvider }               from '@/lib/integrations/registry'
import { storeIntegrationToken }     from '@/lib/integrations/vault'
import { inngest }                   from '@/lib/inngest/client'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider: providerId } = await params
  const { searchParams }         = request.nextUrl
  const code                     = searchParams.get('code')
  const stateParam               = searchParams.get('state')

  if (!code || !stateParam) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 })
  }

  const provider = getProvider(providerId)
  if (!provider) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 404 })
  }

  // ── Verify CSRF state ──────────────────────────────────────────────────────

  const cookieState = request.cookies.get('oauth_state')?.value
  if (!cookieState || cookieState !== stateParam) {
    return NextResponse.json({ error: 'Invalid OAuth state' }, { status: 400 })
  }

  const admin = createServiceClient()

  const { data: storedState } = await admin
    .from('oauth_states')
    .select('id, user_id, expires_at')
    .eq('state', stateParam)
    .eq('provider_id', providerId)
    .single()

  if (!storedState || new Date(storedState.expires_at) < new Date()) {
    return NextResponse.json({ error: 'OAuth state expired or not found' }, { status: 400 })
  }

  // Consume state — delete so it can't be replayed
  await admin.from('oauth_states').delete().eq('id', storedState.id)

  // Clear the cookie
  const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/settings/integrations`)
  response.cookies.set('oauth_state', '', { maxAge: 0, path: '/' })

  // ── Exchange code for token ────────────────────────────────────────────────

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/integrations/${providerId}/callback`
  let tokenResponse

  try {
    tokenResponse = await provider.exchangeCodeForToken(code, redirectUri)
  } catch (err) {
    console.error(`[OAuth:${providerId}] Token exchange failed:`, err instanceof Error ? err.message : err)
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/settings/integrations?error=token_exchange_failed`)
  }

  const { access_token, scope, user_id: externalUserId } = tokenResponse

  // ── Verify the requesting user matches the OAuth session ──────────────────

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.id !== storedState.user_id) {
    return NextResponse.json({ error: 'Session mismatch' }, { status: 403 })
  }

  // ── Resolve org_id ────────────────────────────────────────────────────────

  const { data: member } = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()

  const orgId = member?.org_id ?? null

  // ── Store token in Vault ──────────────────────────────────────────────────

  await storeIntegrationToken(
    user.id,
    providerId,
    access_token,
    String(externalUserId),
    scope,
    { last_connected_at: new Date().toISOString() }
  )

  // ── Upsert integration_connections ────────────────────────────────────────

  await admin
    .from('integration_connections')
    .upsert(
      {
        user_id:          user.id,
        org_id:           orgId,
        provider_id:      providerId,
        external_user_id: String(externalUserId),
        status:           'active',
        metadata: {
          scope,
          connected_at: new Date().toISOString(),
        },
      },
      { onConflict: 'user_id,provider_id' }
    )

  // ── Fire Inngest event ─────────────────────────────────────────────────────

  if (orgId) {
    await inngest.send({
      name: 'integration/ownerrez.connected',
      data: {
        user_id:          user.id,
        org_id:           orgId,
        external_user_id: String(externalUserId),
      },
    })
  }

  return response
}
