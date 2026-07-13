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
//   holds the token via holdPendingIntegrationToken() (Vault-backed,
//   single-use, 30 min TTL) and sends the user through
//   /signup?next=/connect/finish?pending_link=..., and /connect/finish
//   requires requireAuth() — the user must actively sign in or sign up to
//   claim it. This exactly mirrors the existing "new user arriving from
//   marketplace" branch already shipped in ../callback/route.ts (see its
//   no-session branch), it's the same accepted pattern, just made
//   unconditional here instead of a fallback for the no-session case only.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { getProvider } from '@/lib/integrations/registry'
import { holdPendingIntegrationToken } from '@/lib/integrations/vault'

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
  let providerAdapter
  try {
    providerAdapter = getProvider(providerId)
  } catch {
    return errorRedirect('unknown_provider')
  }

  if (!providerAdapter.exchangeCodeForToken) {
    return errorRedirect('provider_not_oauth')
  }

  // ── 3. Exchange the code for a token ────────────────────────
  //    redirectUri is part of every provider adapter's exchangeCodeForToken
  //    signature, but not every provider actually uses it — Hospitable's
  //    adapter (lib/integrations/providers/hospitable.ts) destructures only
  //    `{ code }` and documents that redirect_uri is portal-configured on
  //    their side rather than sent per-request, so this value is inert for
  //    Hospitable specifically. It's still passed here because the shared
  //    IntegrationProvider interface requires it, and because a future
  //    one-click provider (e.g. OwnerRez) may enforce it — in that case it
  //    MUST exactly match the one-click redirect URL registered with that
  //    provider for THIS route, not the standard-flow callback URL.
  const redirectUri = `${appUrl}/api/integrations/${providerId}/callback/oneclick`
  let tokenData

  try {
    tokenData = await providerAdapter.exchangeCodeForToken({ code, redirectUri })
  } catch (err) {
    console.error(`[OAuth:${providerId}:oneclick] Token exchange failed:`, err)
    return errorRedirect('token_exchange_failed')
  }

  // ── 4. Always hold — never attach to an existing session ────
  //    See file header. This is intentional; do not "optimize" this by
  //    checking for an active session and skipping the hold/claim step.
  let pendingLinkToken: string
  try {
    pendingLinkToken = await holdPendingIntegrationToken({
      providerId,
      externalUserId: tokenData.externalUserId,
      accessToken:    tokenData.accessToken,
      refreshToken:   tokenData.refreshToken,
      scope:          tokenData.scope,
      metadata:       tokenData.metadata,
    })
  } catch (err) {
    console.error(`[OAuth:${providerId}:oneclick] Failed to hold pending token:`, err)
    return errorRedirect('storage_failed')
  }

  console.log(
    `[OAuth:${providerId}:oneclick] Token held pending claim — external user ${tokenData.externalUserId}`
  )

  // ── 5. Send through signup/login → claim ─────────────────────
  //    /connect/finish requires requireAuth() (see app/connect/finish/route.ts)
  //    — the user must actively authenticate before this token is linked
  //    to any FieldStay account, regardless of any session already present.
  const signupUrl = new URL('/signup', appUrl)
  signupUrl.searchParams.set('provider', providerId)
  signupUrl.searchParams.set('next', `/connect/finish?pending_link=${pendingLinkToken}`)
  return NextResponse.redirect(signupUrl)
}
