// src/app/api/integrations/[provider]/callback/route.ts
// ============================================================
// OAuth Step 2 & 3: Handle the redirect back from the provider.
//
// What happens here:
//   1. Validate the state token (CSRF protection)
//   2. Catch any authorization errors from the provider
//   3. Resolve the FieldStay user identity FIRST
//   4. With a real user: exchange the temporary code for a token, store it
//      in Supabase Vault, link the org, kick off initial sync
//   5. With no user (marketplace install, no account yet): hold the
//      UNEXCHANGED code for post-signup claim — see below
//   6. Redirect the user to their dashboard (or signup)
//
// ⚠️ Identity resolution deliberately happens BEFORE the token exchange.
//   An earlier version exchanged first and then held the exchanged tokens
//   for users with no account yet. The token exchange is what registers the
//   connection on the provider's side (their UI flips to "Connected"), so
//   that ordering showed users as connected before they had a FieldStay
//   account at all — flagged by Hospitable's partner team 2026-07-22. The
//   no-session branch now holds the unexchanged code instead; the exchange
//   runs in /connect/finish after requireAuth(). Same model as the one-click
//   route (./oneclick/route.ts).
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
import { createServiceClient }            from '@/lib/supabase/server'
import { revalidatePath }                 from 'next/cache'
import { getProvider }                    from '@/lib/integrations/registry'
import { holdPendingOAuthCode }           from '@/lib/integrations/vault'
import { finalizeIntegrationConnection }  from '@/lib/integrations/finalize-connection'
import { logAuditEvent }                  from '@/lib/audit'

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
  const admin = createServiceClient()

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

  // ── 4. Resolve the FieldStay user identity — BEFORE any exchange ──
  //    getUser() makes a network call to verify the JWT — use it, not getSession().
  //    This is also the call most likely to trigger a session refresh (setAll).
  //
  //    Priority order:
  //      A. Active session in the current request cookies  → sessionUser.id
  //      B. user_id stored in the state record when /connect was hit → stateRecord.user_id
  //      C. Neither → new user arriving from the provider's marketplace → hold
  //         the unexchanged code and send to sign-up (see file header for why
  //         the exchange must not happen before signup)
  const { data: { user: sessionUser } } = await supabase.auth.getUser()

  const appUserId: string | null = sessionUser?.id ?? stateRecord.user_id ?? null

  //    OwnerRez: code expires after 10 minutes and is single-use.
  //    We pass redirectUri because we included it in step 1 — it must match exactly,
  //    both on an immediate exchange and on the deferred one in /connect/finish.
  const redirectUri = `${appUrl}/api/integrations/${providerId}/callback`

  if (!appUserId) {
    // "Brand new user arriving from the provider's marketplace" scenario.
    // They have no FieldStay account and didn't start this flow while logged
    // in. Hold the UNEXCHANGED code (Vault-backed, 30 min TTL, single-use)
    // and redirect through signup with a claim token; /connect/finish
    // performs the exchange once they've actively authenticated. If the code
    // has expired by then, /connect/finish falls back to restarting the
    // standard /connect flow — never a dead end.
    console.warn(
      `[OAuth:${providerId}] No FieldStay user identity found. Holding authorization code for post-signup exchange.`
    )

    let pendingLinkToken: string
    try {
      pendingLinkToken = await holdPendingOAuthCode({ providerId, code, redirectUri })
    } catch (err) {
      console.error(`[OAuth:${providerId}] Failed to hold pending authorization code:`, err)
      return errorRedirect('storage_failed')
    }

    const signupUrl = new URL('/signup', appUrl)
    signupUrl.searchParams.set('provider', providerId)
    signupUrl.searchParams.set('next', `/connect/finish?pending_link=${pendingLinkToken}`)
    return makeRedirect(signupUrl)
  }

  // ── 5. Exchange the temporary code for an access token ────
  let tokenData

  try {
    tokenData = await providerAdapter.exchangeCodeForToken({ code, redirectUri })
  } catch (err) {
    console.error(`[OAuth:${providerId}] Token exchange failed:`, err)
    return errorRedirect('token_exchange_failed')
  }

  // ── 6. Store the token, link the org, kick off initial sync ──
  //    Shared with /connect/finish — see lib/integrations/finalize-connection.ts.
  //    The token never touches the browser.
  try {
    await finalizeIntegrationConnection({ userId: appUserId, providerId, tokenData })
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
  const returnTo  = stateRecord.return_to ?? '/settings?tab=integrations'
  // Guard against open redirects: only allow paths starting with /
  const safePath  = returnTo.startsWith('/') ? returnTo : '/settings?tab=integrations'
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
