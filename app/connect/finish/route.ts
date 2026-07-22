// app/connect/finish/route.ts
// ============================================================
// Completes a marketplace install: claims the UNEXCHANGED authorization code
// that was held in pending_oauth_authorizations while the user finished
// signing up (see app/api/integrations/[provider]/callback/oneclick/route.ts,
// the standard callback's no-session branch, and lib/integrations/vault.ts's
// holdPendingOAuthCode/claimPendingOAuthCode), performs the code→token
// exchange HERE — after requireAuth() — and finalizes the connection.
//
// The exchange deliberately happens in this route and nowhere earlier: the
// exchange is what registers the connection on the provider's side, so
// running it pre-signup showed users as "Connected" in the provider's UI
// before any FieldStay account existed (flagged by Hospitable's partner
// team 2026-07-22).
//
// Reached via the existing next-param signup flow — app/(auth)/signup/
// signup-form.tsx carries `next=/connect/finish?pending_link=...` through
// both Google OAuth (fs-oauth-next cookie) and email/password (emailRedirectTo
// query param) signup, and app/(auth)/callback/route.ts redirects here once
// the user has a real session.
//
// Expired-code fallback: provider authorization codes are single-use and
// short-lived (~10 min typically), while email-confirmation signup can take
// longer than that. If the provider rejects the code at exchange time, we
// redirect into the standard /connect flow — the user is authenticated now,
// and a provider re-authorizing an already-granted app bounces straight back
// without re-prompting, so recovery is one redirect, never a dead end.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getProvider } from '@/lib/integrations/registry'
import { claimPendingOAuthCode, cleanupExpiredPendingIntegrationArtifacts } from '@/lib/integrations/vault'
import { finalizeIntegrationConnection } from '@/lib/integrations/finalize-connection'
import { logAuditEvent } from '@/lib/audit'
import { revalidatePath } from 'next/cache'

export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!
  const pendingLinkToken = request.nextUrl.searchParams.get('pending_link')

  const { user } = await requireAuth()

  if (!pendingLinkToken) {
    return NextResponse.redirect(new URL('/settings?tab=integrations', appUrl))
  }

  // Periodic TTL cleanup of expired never-claimed holds — fire-and-forget,
  // ~5% of requests, same pattern as cleanup_webhook_dedup() in the webhook
  // route. Closes FUTURE_REMEDIATION.md #7 (cleanup function existed but was
  // never invoked from anywhere).
  if (Math.random() < 0.05) {
    void cleanupExpiredPendingIntegrationArtifacts()
  }

  // ── 1. Claim the held authorization code (single-use) ──────────────
  let claimed: Awaited<ReturnType<typeof claimPendingOAuthCode>>
  try {
    claimed = await claimPendingOAuthCode(pendingLinkToken)
  } catch (err) {
    console.error('[connect/finish] Claim failed:', err)
    const url = new URL('/connect/error', appUrl)
    url.searchParams.set('error', 'claim_failed')
    return NextResponse.redirect(url)
  }

  if (!claimed) {
    // Expired (30 min TTL) or already claimed — nothing to link. Send them
    // to settings where they can just click Connect again like any other user.
    const url = new URL('/settings', appUrl)
    url.searchParams.set('tab', 'integrations')
    url.searchParams.set('error', 'pending_link_expired')
    return NextResponse.redirect(url)
  }

  const { providerId, code, redirectUri } = claimed

  // ── 2. Exchange the code — the user is authenticated now ───────────
  let providerAdapter
  try {
    providerAdapter = getProvider(providerId)
  } catch {
    const url = new URL('/connect/error', appUrl)
    url.searchParams.set('provider', providerId)
    url.searchParams.set('error', 'unknown_provider')
    return NextResponse.redirect(url)
  }

  if (!providerAdapter.exchangeCodeForToken) {
    const url = new URL('/connect/error', appUrl)
    url.searchParams.set('provider', providerId)
    url.searchParams.set('error', 'provider_not_oauth')
    return NextResponse.redirect(url)
  }

  let tokenData
  try {
    tokenData = await providerAdapter.exchangeCodeForToken({ code, redirectUri })
  } catch (err) {
    // The code expired or was already used on the provider's side (signup —
    // especially with email confirmation — can outlive a provider code's
    // ~10 min lifetime). Restart the standard connect flow: the user is
    // authenticated, the provider auto-approves an already-granted app, so
    // this is a single silent redirect bounce rather than a dead end.
    console.warn(
      `[connect/finish] Deferred token exchange failed for ${providerId} — ` +
      `falling back to standard connect flow:`, err
    )
    const url = new URL(`/api/integrations/${providerId}/connect`, appUrl)
    url.searchParams.set('return_to', '/settings?tab=integrations')
    return NextResponse.redirect(url)
  }

  // ── 3. Store the token, link the org, kick off initial sync ────────
  //    Shared with the standard callback — lib/integrations/finalize-connection.ts.
  //    Initial sync is gated on a real org_id inside the helper: a user who
  //    hasn't finished creating/joining an org yet simply has nothing to
  //    sync until they do.
  try {
    await finalizeIntegrationConnection({ userId: user.id, providerId, tokenData })
  } catch (err) {
    console.error(`[connect/finish] Vault storage failed for ${providerId}:`, err)
    const url = new URL('/connect/error', appUrl)
    url.searchParams.set('provider', providerId)
    url.searchParams.set('error', 'storage_failed')
    return NextResponse.redirect(url)
  }

  await logAuditEvent({
    actorId:    user.id,
    action:     'integration.connected',
    targetType: 'integration_provider',
    targetId:   providerId,
    metadata:   { externalUserId: tokenData.externalUserId, trigger: 'marketplace_install' },
  })

  // Pages that render connection status from integration_connections —
  // same set as the standard callback route.
  revalidatePath('/ops')
  revalidatePath('/settings')
  revalidatePath('/settings/integrations')
  revalidatePath('/setup/power-ups')
  revalidatePath('/setup/pms')
  revalidatePath('/inventory')

  const url = new URL('/settings', appUrl)
  url.searchParams.set('tab', 'integrations')
  url.searchParams.set('connected', providerId)
  return NextResponse.redirect(url)
}
