// app/connect/finish/route.ts
// ============================================================
// Completes a marketplace install: claims a token that was held in
// pending_integration_links while the user finished signing up (see
// app/api/integrations/[provider]/callback/route.ts's no-session branch and
// lib/integrations/vault.ts's holdPendingIntegrationToken/
// claimPendingIntegrationLink).
//
// Reached via the existing next-param signup flow — app/(auth)/signup/
// signup-form.tsx carries `next=/connect/finish?pending_link=...` through
// both Google OAuth (fs-oauth-next cookie) and email/password (emailRedirectTo
// query param) signup, and app/(auth)/callback/route.ts redirects here once
// the user has a real session.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { claimPendingIntegrationLink } from '@/lib/integrations/vault'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'
import { revalidatePath } from 'next/cache'

export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!
  const pendingLinkToken = request.nextUrl.searchParams.get('pending_link')

  const { user } = await requireAuth()

  if (!pendingLinkToken) {
    return NextResponse.redirect(new URL('/settings?tab=integrations', appUrl))
  }

  let claimed: Awaited<ReturnType<typeof claimPendingIntegrationLink>>
  try {
    claimed = await claimPendingIntegrationLink(pendingLinkToken, user.id)
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

  const { providerId, externalUserId, orgId } = claimed

  if (providerId === 'ownerrez') {
    await inngest.send({
      name: 'integration/ownerrez.connected',
      data: { user_id: user.id, org_id: orgId ?? '', external_user_id: externalUserId },
    })
  }
  if (providerId === 'kroger' && orgId) {
    await inngest.send({
      name: 'integration/kroger.connected',
      data: { org_id: orgId, user_id: user.id },
    })
  }
  if (providerId === 'hospitable') {
    await inngest.send({
      name: 'integration/hospitable.connected',
      data: { user_id: user.id, org_id: orgId ?? '', external_user_id: externalUserId },
    })
  }

  await logAuditEvent({
    actorId:    user.id,
    action:     'integration.connected',
    targetType: 'integration_provider',
    targetId:   providerId,
    metadata:   { externalUserId, trigger: 'marketplace_install' },
  })

  revalidatePath('/settings')
  revalidatePath('/settings/integrations')

  const url = new URL('/settings', appUrl)
  url.searchParams.set('tab', 'integrations')
  url.searchParams.set('connected', providerId)
  return NextResponse.redirect(url)
}
