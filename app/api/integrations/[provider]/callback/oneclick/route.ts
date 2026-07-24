// app/api/integrations/[provider]/callback/oneclick/route.ts
// ============================================================
// OAuth one-click callback: handles connections initiated FROM the
// provider's own marketplace (e.g. Hospitable's "Get Started" button on
// their Apps page), as opposed to ../callback/route.ts, which handles
// connections initiated from inside FieldStay's own Connect button.
//
// Key difference from ../callback/route.ts:
//   No `state` parameter is expected or validated here. The provider's
//   marketplace page constructs the authorization URL directly using our
//   client_id and THIS route's URL as redirect_uri — FieldStay never
//   initiates this flow, so there is no state token for us to check.
//
// ⚠️ NO TOKEN EXCHANGE HAPPENS IN THIS ROUTE — deliberately.
//   An earlier version exchanged the code for tokens here, on the raw
//   unauthenticated GET, and held the exchanged tokens for post-signup
//   claim. Hospitable's partner team flagged the consequence (2026-07-22):
//   the token exchange is what registers the connection on the provider's
//   side, so their UI showed "Connected" before the user had any FieldStay
//   account — and an abandoned signup left that dangling Connected state
//   (plus an unrevoked refresh token in an expired pending row) forever.
//   This route now holds the UNEXCHANGED authorization code instead
//   (Vault-backed, single-use, 30 min TTL) and the exchange runs in
//   /connect/finish, after requireAuth(). Do not "optimize" by exchanging
//   early again.
//
// SECURITY MODEL — read before modifying:
//   Because there is no state/CSRF token, this route must NEVER attach the
//   resulting connection to whatever FieldStay session happens to be active
//   in the browser at request time. Doing so would allow a confused-deputy
//   attack: an attacker completes their OWN authorization with the provider
//   to obtain a valid `code`, then tricks a logged-in FieldStay victim's
//   browser into hitting this URL with that code — silently linking the
//   attacker's provider account into the victim's FieldStay org.
//
//   Mitigation: this route ALWAYS treats the arrival as an unauthenticated
//   marketplace install, regardless of any existing session cookie. It
//   holds the code via holdPendingOAuthCode() and sends the user through
//   /signup?next=/connect/finish?pending_link=..., and /connect/finish
//   requires requireAuth() — the user must actively sign in or sign up to
//   claim it. Deferring the exchange strengthens this further: nothing is
//   even registered with the provider until that active authentication
//   happens.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { getProvider } from '@/lib/integrations/registry'
import { holdPendingOAuthCode, cleanupExpiredPendingIntegrationArtifacts } from '@/lib/integrations/vault'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const resolvedParams = await params
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL!
  const providerId = resolvedParams.provider.toLowerCase()
  const { searchParams } = request.nextUrl

  const code             = searchParams.get('code')
  const providerError    = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  function errorRedirect(reason: string): NextResponse {
    const url = new URL('/connect/error', appUrl)
    url.searchParams.set('provider', providerId)
    url.searchParams.set('error', reason)
    return NextResponse.redirect(url)
  }

  // ── 1. Handle provider-level authorization errors ──────────
  //    e.g. user clicked "Deny" on the provider's authorization screen.
  if (providerError) {
    console.warn(
      `[OAuth:${providerId}:oneclick] Authorization denied: ${providerError} — ${errorDescription}`
    )
    return errorRedirect(providerError)
  }

  if (!code) {
    return errorRedirect('missing_params')
  }

  // ── 2. Load the provider adapter ────────────────────────────
  //    Validated here even though the exchange is deferred — an unknown or
  //    non-OAuth provider should fail now, not after the user has gone
  //    through the whole signup flow.
  let providerAdapter
  try {
    providerAdapter = getProvider(providerId)
  } catch {
    return errorRedirect('unknown_provider')
  }

  if (!providerAdapter.exchangeCodeForToken) {
    return errorRedirect('provider_not_oauth')
  }

  // ── 3. Hold the unexchanged code — never exchange here ──────
  //    See file header. The stored redirectUri is replayed on the deferred
  //    exchange in /connect/finish for providers that enforce redirect_uri
  //    matching (inert for Hospitable, whose redirect_uri is
  //    portal-configured; a future one-click provider may enforce it, in
  //    which case it MUST be the one-click URL registered for THIS route).
  const redirectUri = `${appUrl}/api/integrations/${providerId}/callback/oneclick`
  let pendingLinkToken: string

  try {
    pendingLinkToken = await holdPendingOAuthCode({ providerId, code, redirectUri })
  } catch (err) {
    console.error(`[OAuth:${providerId}:oneclick] Failed to hold pending authorization code:`, err)
    return errorRedirect('storage_failed')
  }

  console.log(
    `[OAuth:${providerId}:oneclick] Authorization code held — exchange deferred until post-signup claim`
  )

  // Periodic TTL cleanup of expired never-claimed holds — fire-and-forget,
  // runs on ~5% of arrivals to amortise cleanup cost without a dedicated
  // cron. Same pattern as cleanup_webhook_dedup() in the webhook route.
  if (Math.random() < 0.05) {
    void cleanupExpiredPendingIntegrationArtifacts()
  }

  // ── 4. Send through signup/login → claim ─────────────────────
  //    /connect/finish requires requireAuth() (see app/connect/finish/route.ts)
  //    — the user must actively authenticate before the code is exchanged or
  //    linked to any FieldStay account, regardless of any session already
  //    present in this browser.
  const signupUrl = new URL('/signup', appUrl)
  signupUrl.searchParams.set('provider', providerId)
  signupUrl.searchParams.set('next', `/connect/finish?pending_link=${pendingLinkToken}`)
  return NextResponse.redirect(signupUrl)
}
