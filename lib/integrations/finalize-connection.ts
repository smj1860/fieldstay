// lib/integrations/finalize-connection.ts
// ============================================================
// Shared post-exchange connection finalization, used by BOTH places a
// successful code→token exchange can happen:
//   - app/api/integrations/[provider]/callback/route.ts (session/state user)
//   - app/connect/finish/route.ts (marketplace install, deferred exchange
//     after signup)
//
// Does, in order:
//   1. Store the access token (and refresh token, if any) in Vault
//   2. Link the connection to the user's earliest accepted org membership
//   3. Fire the provider's initial-sync event — gated on a real org_id,
//      because the sync functions write org-scoped rows (properties.org_id
//      is NOT NULL) and fail outright without one, which previously flipped
//      a brand-new connection to status='error' seconds after connecting.
//      A user with no org yet simply has nothing to sync until they have one.
// ============================================================

import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import { storeIntegrationToken, storeIntegrationRefreshToken } from '@/lib/integrations/vault'
import { inngest } from '@/lib/inngest/client'
import type { TokenResponse } from '@/lib/integrations/types'

interface OAuthConnectedContext {
  userId:         string
  orgId:          string
  externalUserId: string
}

// One entry per provider that needs an initial-sync event fired right after
// a successful OAuth connect. Each event has its own payload shape (Kroger's
// doesn't carry external_user_id), so entries are dispatch functions rather
// than plain event-name strings — adding a new provider here is one table
// entry instead of a new `if (providerId === '...')` block.
const OAUTH_CONNECTED_EVENTS: Partial<Record<string, (ctx: OAuthConnectedContext) => Promise<unknown>>> = {
  ownerrez: (ctx) => inngest.send({
    name: 'integration/ownerrez.connected',
    data: { user_id: ctx.userId, org_id: ctx.orgId, external_user_id: ctx.externalUserId },
  }),
  kroger: (ctx) => inngest.send({
    name: 'integration/kroger.connected',
    data: { org_id: ctx.orgId, user_id: ctx.userId },
  }),
  hospitable: (ctx) => inngest.send({
    name: 'integration/hospitable.connected',
    data: { user_id: ctx.userId, org_id: ctx.orgId, external_user_id: ctx.externalUserId },
  }),
}

/**
 * Store an exchanged token against a real FieldStay user, link it to their
 * org, and kick off the provider's initial sync. Throws on Vault/storage
 * failure — callers map that to their own storage_failed redirect.
 */
export async function finalizeIntegrationConnection(params: {
  userId:     string
  providerId: string
  tokenData:  TokenResponse
}): Promise<{ orgId: string | null }> {
  const { userId, providerId, tokenData } = params

  await storeIntegrationToken({
    userId,
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
      userId,
      providerId,
      refreshToken: tokenData.refreshToken,
      expiresAt:    tokenData.expiresAt,
    })
  }

  // Link this connection to the user's org so Inngest steps and server
  // actions that only have org context (e.g. cart automation) can find it.
  // Deterministic earliest-accepted-membership rule, same as
  // claim_pending_integration_link()'s org resolution.
  const admin = createServiceClient()
  const { data: membership } = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', userId)
    .not('invite_accepted_at', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (membership?.org_id) {
    await admin
      .from('integration_connections')
      .update({ org_id: membership.org_id })
      .eq('user_id', userId)
      .eq('provider_id', providerId)
      // Only update rows with no org yet (first connect) or already belonging
      // to this org (reconnect). Never silently repoint a connection owned by
      // a different org the user is also a member of. Mirrors connectWithApiKey.
      .or(`org_id.is.null,org_id.eq.${membership.org_id}`)
  }

  const fireConnectedEvent = OAUTH_CONNECTED_EVENTS[providerId]
  if (fireConnectedEvent && membership?.org_id) {
    await fireConnectedEvent({
      userId,
      orgId:          membership.org_id,
      externalUserId: tokenData.externalUserId,
    })
  }

  return { orgId: membership?.org_id ?? null }
}
