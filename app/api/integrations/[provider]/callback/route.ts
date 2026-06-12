// src/app/api/integrations/[provider]/callback/route.ts
// ============================================================
// OAuth Step 2 & 3: Handle the redirect back from the provider.
//
// What happens here:
//   1. Validate the state token (CSRF protection)
//   2. Catch any authorization errors from the provider
//   3. Exchange the temporary code for a long-lived access token
//   4. Ensure the user has a FieldStay account (create one if not)
//   5. Store the token securely in Supabase Vault
//   6. Redirect the user to their dashboard
//
// This route URL MUST match exactly what you registered with OwnerRez:
//   https://fieldstay.app/api/integrations/ownerrez/callback
//
// Cookie strategy:
//   This handler has multiple exit points (various error redirects, a
//   sign-up redirect, and a success redirect). We use a single
//   NextResponse.next() accumulator wired into the Supabase client's
//   setAll() callback. Every redirect we return passes through makeRedirect(),
//   which copies the accumulated session cookies onto that specific response
//   and clears the one-time OAuth state cookie. This guarantees the session
//   is correctly propagated regardless of which exit path is taken.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient }             from '@supabase/ssr'
import { createClient }                   from '@supabase/supabase-js'
import { revalidatePath }                 from 'next/cache'
import { getProvider }                    from '@/lib/integrations/registry'
import { storeIntegrationToken, storeIntegrationRefreshToken } from '@/lib/integrations/vault'
import { logAuditEvent }                  from '@/lib/audit'
import { inngest }                        from '@/lib/inngest/client'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const resolvedParams = await params
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL!
  const providerId = resolvedParams.provider.toLowerCase()
  const { searchParams } = request.nextUrl

  // Parameters sent back by the provider after the user acts on the auth screen
  const code             = searchParams.get('code')
  const returnedState    = searchParams.get('state')
  const providerError    = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  // ── Set up Supabase client with response-bound cookie accumulator ──
  //
  //    getUser() is called later in this handler. If Supabase refreshes
  //    the session at that point, setAll() fires. We must ensure those
  //    refreshed cookies land on whatever redirect response we return.
  //
  //    supabaseResponse acts as a cookie accumulator. Every exit point in
  //    this handler goes through makeRedirect(), which copies those cookies
  //    onto the real redirect response and clears the OAuth state cookie.
  const supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        // Read from the incoming request (where the user's session cookie lives)
        getAll() {
          return request.cookies.getAll()
        },
        // Write to both the request (for in-handler consistency)
        // and the accumulator response (to carry onto the final redirect)
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // ── Helper: every redirect in this handler goes through here ──────
  //    - Copies any Supabase session refreshes onto the response
  //    - Clears the one-time OAuth state cookie
  //    This ensures correct session propagation regardless of exit path.
  function makeRedirect(destination: string | URL): NextResponse {
    const res = NextResponse.redirect(destination, { status: 302 })
    // Transfer any session token refreshes Supabase performed during getUser()
    supabaseResponse.cookies.getAll().forEach((cookie) => res.cookies.set(cookie))
    // Always clean up the one-time state cookie on every exit
    res.cookies.delete(`oauth_state_${providerId}`)
    return res
  }

  function errorRedirect(reason: string): NextResponse {
    const url = new URL('/connect/error', appUrl)
    url.searchParams.set('provider', providerId)
    url.searchParams.set('error',    reason)
    return makeRedirect(url)
  }

  // ── 1. Handle provider-level authorization errors ──────────
  //    e.g. user clicked "Deny" on the OwnerRez authorization screen,
  //    or a redirect_uri mismatch occurred
  if (providerError) {
    console.warn(
      `[OAuth:${providerId}] Authorization denied: ${providerError} — ${errorDescription}`
    )
    return errorRedirect(providerError)
  }

  if (!code || !returnedState) {
    return errorRedirect('missing_params')
  }

  // ── 2. Validate the state token (CSRF protection) ──────────
  //    We use the service-role client here because oauth_states has no
  //    RLS policy for reads — it is a server-side-only table.
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: stateRecord, error: stateError } = await admin
    .from('oauth_states')
    .select('*')
    .eq('state',       returnedState)
    .eq('provider_id', providerId)
    .gt('expires_at',  new Date().toISOString())  // reject expired codes
    .single()

  if (stateError || !stateRecord) {
    console.error(
      `[OAuth:${providerId}] State validation failed — ` +
      `possible CSRF attempt or expired flow (state: ${returnedState?.slice(0, 8)}...)`
    )
    return errorRedirect('invalid_state')
  }

  // Immediately consume the state record — one-time use prevents replay attacks
  await admin.from('oauth_states').delete().eq('state', returnedState)

  // ── 3. Load the provider adapter ──────────────────────────
  let providerAdapter
  try {
    providerAdapter = getProvider(providerId)
  } catch {
    return errorRedirect('unknown_provider')
  }

  if (!providerAdapter.exchangeCodeForToken) {
    return errorRedirect('provider_not_oauth')
  }

  // ── 4. Exchange the temporary code for an access token ────
  //    OwnerRez: code expires after 10 minutes and is single-use.
  //    We pass redirectUri because we included it in step 1 — it must match exactly.
  const redirectUri = `${appUrl}/api/integrations/${providerId}/callback`
  let tokenData

  try {
    tokenData = await providerAdapter.exchangeCodeForToken({ code, redirectUri })
  } catch (err) {
    console.error(`[OAuth:${providerId}] Token exchange failed:`, err)
    return errorRedirect('token_exchange_failed')
  }

  // ── 5. Resolve the FieldStay user identity ─────────────────
  //    getUser() makes a network call to verify the JWT — use it, not getSession().
  //    This is also the call most likely to trigger a session refresh (setAll).
  //
  //    Priority order:
  //      A. Active session in the current request cookies  → sessionUser.id
  //      B. user_id stored in the state record when /connect was hit → stateRecord.user_id
  //      C. Neither → new user arriving from OwnerRez marketplace → send to sign-up
  const { data: { user: sessionUser } } = await supabase.auth.getUser()

  const appUserId: string | null = sessionUser?.id ?? stateRecord.user_id ?? null

  if (!appUserId) {
    // This is the "brand new user arriving from the OwnerRez marketplace" scenario.
    // They have no FieldStay account and didn't start this flow while logged in.
    //
    // TODO: Implement post-signup token linking so the connection completes
    // after the user creates their account.
    //
    // ⚠️ Ask OwnerRez: when a user clicks "Connect FieldStay" in your marketplace,
    // do they arrive at our /connect endpoint already authenticated in OwnerRez,
    // or do they land on a FieldStay page first? Understanding this handoff
    // determines the best account-creation flow here.
    console.warn(
      `[OAuth:${providerId}] No FieldStay user identity found. Redirecting to sign-up.`
    )
    const signupUrl = new URL('/signup', appUrl)
    signupUrl.searchParams.set('provider', providerId)
    signupUrl.searchParams.set('next',     `/api/integrations/${providerId}/connect`)
    return makeRedirect(signupUrl)
  }

  // ── 6. Store the token securely in Vault ──────────────────
  //    This calls our security-definer PL/pgSQL function via the
  //    service-role client. The token never touches the browser.
  try {
    await storeIntegrationToken({
      userId:         appUserId,
      providerId,
      accessToken:    tokenData.accessToken,
      externalUserId: tokenData.externalUserId,
      scope:          tokenData.scope,
      metadata:       tokenData.metadata,
    })

    // Refresh token (if the provider returned one) goes into its own Vault
    // secret — never into `metadata`, which is plaintext jsonb.
    if (tokenData.refreshToken) {
      await storeIntegrationRefreshToken({
        userId:       appUserId,
        providerId,
        refreshToken: tokenData.refreshToken,
        expiresAt:    tokenData.expiresAt,
      })
    }

    // Link this connection to the user's org so Inngest steps and server
    // actions that only have org context (e.g. cart automation) can find it.
    const { data: membership } = await admin
      .from('organization_members')
      .select('org_id')
      .eq('user_id', appUserId)
      .not('invite_accepted_at', 'is', null)
      .limit(1)
      .maybeSingle()

    if (membership?.org_id) {
      await admin
        .from('integration_connections')
        .update({ org_id: membership.org_id })
        .eq('user_id', appUserId)
        .eq('provider_id', providerId)
    }

    // ── 7. Kick off initial data sync ─────────────────────────────
    if (providerId === 'ownerrez') {
      await inngest.send({
        name: 'integration/ownerrez.connected',
        data: {
          user_id:          appUserId,
          org_id:           membership?.org_id ?? '',
          external_user_id: tokenData.externalUserId,
        },
      })
    }
  } catch (err) {
    console.error(`[OAuth:${providerId}] Vault storage failed:`, err)
    return errorRedirect('storage_failed')
  }

  // Pages that render connection status from integration_connections —
  // without this, they keep serving the pre-connection cached render.
  revalidatePath('/ops')
  revalidatePath('/settings')
  revalidatePath('/settings/integrations')
  revalidatePath('/setup/power-ups')
  revalidatePath('/setup/pms')
  revalidatePath('/inventory')

  // ── 7. Success — redirect to dashboard ────────────────────
  const returnTo  = stateRecord.return_to ?? '/ops'
  // Guard against open redirects: only allow paths starting with /
  const safePath  = returnTo.startsWith('/') ? returnTo : '/ops'
  const returnUrl = new URL(safePath, appUrl)

  // Pass a success flag so the UI can show a "Connected!" toast
  returnUrl.searchParams.set('connected', providerId)

  console.log(
    `[OAuth:${providerId}] Successfully connected — ` +
    `FieldStay user ${appUserId} / external user ${tokenData.externalUserId}`
  )

  await logAuditEvent({
    actorId:    appUserId,
    action:     'integration.connected',
    targetType: 'integration_provider',
    targetId:   providerId,
    metadata:   { externalUserId: tokenData.externalUserId },
  })

  return makeRedirect(returnUrl)
}
