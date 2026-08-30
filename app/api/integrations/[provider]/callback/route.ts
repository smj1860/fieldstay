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
import { RateLimitError, IntegrationMisconfiguredError } from '@/lib/integrations/types'
import { timingSafeEqual }                 from '@/lib/integrations/webhook-verification'

import { reportError } from '@/lib/observability/report-error'

// Providers whose exchangeCodeForToken error message is confirmed to carry
// only a parsed error_description/error field from the provider's response
// (never raw response text) — safe to surface to the user via the
// /connect/error `detail` query param. kroger.ts is deliberately excluded;
// see the token-exchange catch block below.
// hostex.ts qualifies on the same terms: every branch of
// parseHostexTokenResponse throws either Hostex's own parsed error_msg
// (HostexOAuthError) or a fixed internal string. The one branch that used to
// interpolate raw response content — the unrecognized-shape case — now logs
// the key names and throws a fixed message instead.
const SAFE_DETAIL_PROVIDERS = new Set(['hospitable', 'ownerrez', 'hostex'])

const DEFAULT_RETURN_PATH = '/settings?tab=integrations'

/**
 * Which redirect a failed token exchange should produce, and whether the
 * provider's own message is safe to show the user.
 *
 * Split out of GET() so the reasoning below stays readable next to the three
 * outcomes it decides between, rather than nested inside the handler's own
 * branching.
 */
function classifyTokenExchangeError(
  providerId: string,
  err:        unknown,
): { reason: string; detail?: string } {
  // This runs outside any Inngest step — there's no retry mechanism to
  // lean on here, so a rate limit gets its own clear reason instead of
  // the generic failure message, telling the PM it's transient and to
  // just try again shortly rather than suggesting something is broken.
  if (err instanceof RateLimitError) {
    console.warn(`[OAuth:${providerId}] Token exchange rate limited (retry after ${err.retryAfter}s)`)
    return { reason: 'rate_limited' }
  }

  console.error(`[OAuth:${providerId}] Token exchange failed:`, err)
  reportError(err, { site: 'route.integrations.callback.errorRedirect' })

  if (err instanceof IntegrationMisconfiguredError) {
    // Our own server-side credentials (CLIENT_ID/SECRET env vars) are
    // missing — an operational bug, not something the provider reported
    // or the user caused. Never surface this as `detail`: it's an
    // internal config detail, not an actionable reason, and showing it
    // to an unauthenticated visitor is pure information disclosure with
    // no upside (they can't fix a missing env var by retrying).
    console.error(`[OAuth:${providerId}] MISCONFIGURED — check ${providerId.toUpperCase()}_CLIENT_ID/SECRET env vars`)
    return { reason: 'token_exchange_failed' }
  }

  // Thread the actual provider-reported reason through — e.g. a plan
  // restriction (Hospitable Essentials tier lacks API access) — so the
  // PM sees something actionable instead of a generic "try again" that
  // sends them into a reconnect loop that can never succeed.
  //
  // Only for providers whose exchangeCodeForToken message is confirmed to
  // extract a specific error_description/error field from the provider's
  // response (hospitable.ts, ownerrez.ts) rather than embedding raw
  // response text — kroger.ts's exchangeCodeForCustomerToken
  // (lib/kroger/client.ts) throws with the unparsed response body
  // verbatim, which hasn't been verified to never contain anything
  // beyond a plain error reason, so it's excluded here rather than
  // assumed safe.
  const safeDetail = SAFE_DETAIL_PROVIDERS.has(providerId) && err instanceof Error
  return { reason: 'token_exchange_failed', detail: safeDetail ? err.message : undefined }
}

/**
 * Which FieldStay user this connection binds to.
 *
 * Same browser → the live session wins (a mid-flow account switch binds to who
 * the user actually is now). Otherwise the owner /connect recorded wins,
 * falling back to the session only when /connect had nobody to record — the
 * marketplace arrival. See the `sameBrowser` commentary in GET() for why the
 * cookie, and not the state row, is what decides this.
 */
function resolveAppUserId(args: {
  sameBrowser:   boolean
  sessionUserId: string | null
  stateUserId:   string | null
}): string | null {
  const { sameBrowser, sessionUserId, stateUserId } = args
  const preferred = sameBrowser ? sessionUserId : stateUserId
  const fallback  = sameBrowser ? stateUserId : sessionUserId
  return preferred ?? fallback ?? null
}

/**
 * The post-connect destination, guarded against open redirects.
 *
 * `startsWith('/')` ALONE is not sufficient and was the bug:
 * '//evil.com'.startsWith('/') is true, and
 * new URL('//evil.com/x', 'https://app.fieldstay.com') resolves to
 * https://evil.com/x — a protocol-relative URL is absolute. `return_to` is
 * taken verbatim from /connect's query string, so this sent the victim off-site
 * carrying a FieldStay-looking ?connected= param. A backslash is rejected for
 * the same reason: browsers normalise '/\' to '//'.
 */
function safeReturnPath(returnTo: string | null): string {
  const candidate = returnTo ?? DEFAULT_RETURN_PATH
  const isRelative =
    candidate.startsWith('/') && !candidate.startsWith('//') && !candidate.startsWith('/\\')
  return isRelative ? candidate : DEFAULT_RETURN_PATH
}

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

  function errorRedirect(reason: string, detail?: string): NextResponse {
    const url = new URL('/connect/error', appUrl)
    url.searchParams.set('provider', providerId)
    url.searchParams.set('error',    reason)
    // Cap length — this becomes a URL query param and gets rendered as
    // plain text on /connect/error. Never pass anything that could contain
    // a secret; exchangeCodeForToken's thrown message is built from
    // Hospitable's own error_description field, which is documented as a
    // human-readable reason string, not a credential.
    if (detail) url.searchParams.set('detail', detail.slice(0, 200))
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
  const admin = createServiceClient({ publicSurface: 'integrations-oauth-callback' })

  //    Validation and consumption are ONE atomic statement. This used to be a
  //    SELECT, then a separate DELETE — a check-then-delete that two
  //    concurrent callbacks replaying the same `state` both passed, because
  //    nothing stopped the second SELECT from running before the first
  //    DELETE landed. That defeats the one-time-use property the state token
  //    exists to provide. DELETE ... RETURNING is serialised by Postgres:
  //    exactly one caller gets the row back, everyone else gets zero rows and
  //    is rejected as invalid.
  const { data: stateRecord, error: stateError } = await admin
    .from('oauth_states')
    .delete()
    .eq('state',       returnedState)
    .eq('provider_id', providerId)
    .gt('expires_at',  new Date().toISOString())  // reject expired codes
    .select('*')
    .maybeSingle()

  if (stateError || !stateRecord) {
    console.error(
      `[OAuth:${providerId}] State validation failed — ` +
      `possible CSRF attempt, replayed callback, or expired flow (state: ${returnedState?.slice(0, 8)}...)`
    )
    return errorRedirect('invalid_state')
  }

  //    The state COOKIE is the second half of the CSRF check, and until now it
  //    was written by /connect, described in-comment as a "secondary
  //    verification source", and then never actually compared — only deleted.
  //    That left the DB row as the only proof, and a DB row is not proof the
  //    person completing the flow is the person who started it: anyone can
  //    start a flow, authorize with their OWN provider account, capture the
  //    resulting callback URL, and hand it to a logged-in PM. The state row is
  //    real, unexpired and for the right provider, so validation passed and
  //    the attacker's PMS account got bound to the victim's org.
  //
  //    The cookie closes that, because an attacker cannot set it in the
  //    victim's browser. Enforced only for a flow that HAD a browser to set it
  //    in — a marketplace arrival legitimately has no prior cookie, and that
  //    path is separately gated below by requiring a real signup before the
  //    code is ever exchanged.
  const stateCookie = request.cookies.get(`oauth_state_${providerId}`)?.value ?? null

  //    `sameBrowser` is what the cookie actually proves: this request carries
  //    the one-time value /connect set when the flow STARTED, so the browser
  //    finishing the handshake is the browser that began it. An attacker
  //    cannot set a cookie in the victim's browser, which is why this — and
  //    not the DB row — is what distinguishes a legitimate mid-flow account
  //    switch from a forwarded callback URL.
  const sameBrowser = stateCookie !== null && timingSafeEqual(stateCookie, returnedState)

  //    A cookie that is PRESENT but wrong is never legitimate. Absent is
  //    allowed: a marketplace arrival has no prior cookie, and that path is
  //    separately gated below by requiring a real signup before the code is
  //    ever exchanged.
  if (stateCookie !== null && !sameBrowser) {
    console.error(
      `[OAuth:${providerId}] State cookie mismatch — the callback was completed in a ` +
      `different browser session than the one that started it (state: ${returnedState.slice(0, 8)}...)`
    )
    return errorRedirect('invalid_state')
  }

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

  //    Whether the SESSION may override the owner /connect recorded turns on
  //    `sameBrowser`, not on the session alone.
  //
  //    Unconditionally preferring sessionUser (the previous behavior) meant a
  //    flow started by one person could be completed by, and bound to,
  //    whoever opened the callback URL. That is the whole attack: start a
  //    flow, authorize with your OWN provider account, send the resulting
  //    callback URL to a logged-in PM. The state row is real, unexpired and
  //    for the right provider, so it validated — and the attacker's PMS
  //    account became the victim org's live integration. Inbound webhooks
  //    then resolve that external account straight to the victim's org, so
  //    the cross-tenant write access persists well beyond the handshake.
  //
  //    But a session/state mismatch is not always hostile: the same person
  //    may have started the flow signed out (or as another account) and
  //    signed in before finishing. That case is indistinguishable from the
  //    attack by user ids alone — and entirely distinguishable by the cookie,
  //    which only the originating browser has.
  if (stateRecord.user_id && sessionUser?.id && sessionUser.id !== stateRecord.user_id && !sameBrowser) {
    console.error(
      `[OAuth:${providerId}] State owner does not match the active session and the ` +
      `originating browser cannot be confirmed — refusing to bind this connection ` +
      `(state: ${returnedState.slice(0, 8)}...)`
    )
    return errorRedirect('invalid_state')
  }

  //    Which of the two identities wins — see resolveAppUserId above.
  const appUserId: string | null = resolveAppUserId({
    sameBrowser,
    sessionUserId: sessionUser?.id ?? null,
    stateUserId:   stateRecord.user_id ?? null,
  })

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
      reportError(err, { site: 'route.integrations.callback.errorRedirect' })
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
    const { reason, detail } = classifyTokenExchangeError(providerId, err)
    return errorRedirect(reason, detail)
  }

  // ── 6. Store the token, link the org, kick off initial sync ──
  //    Shared with /connect/finish — see lib/integrations/finalize-connection.ts.
  //    The token never touches the browser.
  try {
    await finalizeIntegrationConnection({ userId: appUserId, providerId, tokenData })
  } catch (err) {
    console.error(`[OAuth:${providerId}] Vault storage failed:`, err)
    reportError(err, { site: 'route.integrations.callback.errorRedirect' })
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
  const returnUrl = new URL(safeReturnPath(stateRecord.return_to), appUrl)

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
