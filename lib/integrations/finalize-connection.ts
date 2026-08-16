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

import { unwrap } from '@/lib/supabase/unwrap'
import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import { storeIntegrationToken, storeIntegrationRefreshToken } from '@/lib/integrations/vault'
import { inngest } from '@/lib/inngest/client'
import { reportError } from '@/lib/observability/report-error'
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
  // Phase 1: no Inngest function subscribes to this yet, so it is recorded
  // and nothing runs. Wired now so the connect path is complete when Phase 3
  // adds the sync function — and so the event shows up in the Inngest
  // dashboard as proof the connect actually reached this point.
  hostex: (ctx) => inngest.send({
    name: 'integration/hostex.connected',
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
  const admin = createServiceClient({ system: 'lib/integrations/finalize-connection' })
  // Completes the fix described on the link write below: discarding THIS
  // error leaves `membership` null, which skips the link entirely — the same
  // org-less connection and silently-never-run sync, just caused by the read.
  const membershipRes = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', userId)
    .not('invite_accepted_at', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  const membership = unwrap(membershipRes, { site: 'lib.integrations.finalize-connection.membership' })

  // Whether this connection row is confirmed to belong to `membership.org_id`
  // after the link below. Only then is it safe to fire an org-scoped initial
  // sync — firing for an org whose connection row is owned by a DIFFERENT org
  // starts a sync that cannot find its own token.
  let linkedOrgId: string | null = null

  if (membership?.org_id) {
    // (user_id, provider_id) is UNIQUE on integration_connections, so this
    // targets at most one row — maybeSingle() both bounds the read and lets a
    // 0-row result be told apart from a failed write. The error used to be
    // discarded entirely: a failed link left the connection org-less and the
    // sync silently never ran, with nothing logged.
    const { data: linked, error: linkError } = await admin
      .from('integration_connections')
      .update({ org_id: membership.org_id })
      .eq('user_id', userId)
      .eq('provider_id', providerId)
      // Only update rows with no org yet (first connect) or already belonging
      // to this org (reconnect). Never silently repoint a connection owned by
      // a different org the user is also a member of. Mirrors connectWithApiKey.
      .or(`org_id.is.null,org_id.eq.${membership.org_id}`)
      .select('id')
      .maybeSingle()

    if (linkError) {
      // The token IS stored at this point, so this is a partial failure. Throw
      // rather than return a half-linked connection: callers map it to their
      // storage_failed redirect, and a retry is idempotent
      // (store_integration_token updates the existing row).
      console.error('[finalizeIntegrationConnection] org link failed', linkError)
      reportError(linkError, {
        site:  'lib.integrations.finalizeIntegrationConnection.link',
        orgId: membership.org_id,
        extra: { provider_id: providerId },
      })
      throw new Error('Failed to link integration connection to organization')
    }

    if (linked) {
      linkedOrgId = membership.org_id
    } else {
      // 0 rows matched: the row exists but is owned by another org this user
      // also belongs to. Expected and deliberately non-fatal — but it must not
      // be followed by an initial sync attributed to the wrong org.
      console.warn(
        '[finalizeIntegrationConnection] connection already owned by another org — not relinking',
        { provider_id: providerId },
      )
    }
  }

  const fireConnectedEvent = OAUTH_CONNECTED_EVENTS[providerId]
  if (fireConnectedEvent && linkedOrgId) {
    await fireConnectedEvent({
      userId,
      orgId:          linkedOrgId,
      externalUserId: tokenData.externalUserId,
    })
  }

  return { orgId: linkedOrgId }
}
