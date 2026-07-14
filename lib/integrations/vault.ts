// src/lib/integrations/vault.ts
// ============================================================
// The single, controlled gateway to Supabase Vault token storage.
//
// SECURITY RULES:
//   - Only import this file in server-side code (Route Handlers, Inngest, Edge Functions)
//   - Uses SUPABASE_SERVICE_ROLE_KEY — never expose this key to the browser
//   - Tokens are never logged. Never add console.log(token) anywhere in this file.
//   - The browser (anon/authenticated role) cannot call the underlying DB functions
// ============================================================

import { createServiceClient } from '@/lib/supabase/server'
import { randomBytes } from 'crypto'

/** Service-role admin client, routed through the one central helper. */
function getAdminClient() {
  return createServiceClient()
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Securely store (or update) an integration access token in Supabase Vault.
 * Creates a new connection record if one doesn't exist, or updates the
 * existing Vault secret and connection metadata if it does.
 *
 * @returns The Vault secret UUID (for audit purposes — not the token itself)
 */
export async function storeIntegrationToken(params: {
  userId: string
  providerId: string
  accessToken: string
  externalUserId: string
  scope?: string
  metadata?: Record<string, unknown>
}): Promise<string> {
  const admin = getAdminClient()

  const { data: secretId, error } = await admin.rpc('store_integration_token', {
    p_user_id:          params.userId,
    p_provider_id:      params.providerId,
    p_access_token:     params.accessToken,
    p_external_user_id: params.externalUserId,
    p_scope:            params.scope ?? null,
    p_metadata:         params.metadata ?? {},
  })

  if (error) {
    // Log the error message but NOT the token
    throw new Error(
      `[Vault] Failed to store token for provider "${params.providerId}": ${error.message}`
    )
  }

  return secretId as string
}

/**
 * Retrieve and decrypt a stored access token from Vault.
 * Returns null if the user has no active connection for the given provider.
 *
 * IMPORTANT: Use this token immediately for an API call.
 * Do not store it in any variable that persists beyond the current request.
 */
export async function readIntegrationToken(
  userId: string,
  providerId: string
): Promise<string | null> {
  const admin = getAdminClient()

  const { data: token, error } = await admin.rpc('read_integration_token', {
    p_user_id:     userId,
    p_provider_id: providerId,
  })

  if (error) {
    throw new Error(
      `[Vault] Failed to read token for provider "${providerId}": ${error.message}`
    )
  }

  return token as string | null
}

/**
 * Revoke and permanently destroy a stored access token.
 * Marks the connection as 'revoked' and deletes the Vault secret.
 * This cannot be undone — the user must re-authorize to reconnect.
 */
export async function revokeIntegrationToken(
  userId: string,
  providerId: string
): Promise<void> {
  const admin = getAdminClient()

  const { error } = await admin.rpc('revoke_integration_token', {
    p_user_id:     userId,
    p_provider_id: providerId,
  })

  if (error) {
    throw new Error(
      `[Vault] Failed to revoke token for provider "${providerId}": ${error.message}`
    )
  }
}

/**
 * Disconnect a connection the user chose to end deliberately (clicked
 * Disconnect in Settings). Same secret-cleanup behavior as
 * revokeIntegrationToken, but marks status 'disconnected' instead of
 * 'revoked' — so the UI doesn't show this as an error requiring urgent
 * reconnection. Use revokeIntegrationToken for involuntary/webhook-driven
 * revocation; use this one only for the user-initiated disconnect action.
 */
export async function disconnectIntegrationToken(
  userId: string,
  providerId: string
): Promise<void> {
  const admin = getAdminClient()

  const { error } = await admin.rpc('disconnect_integration_token', {
    p_user_id:     userId,
    p_provider_id: providerId,
  })

  if (error) {
    throw new Error(
      `[Vault] Failed to disconnect token for provider "${providerId}": ${error.message}`
    )
  }
}

/**
 * Securely store (or update) an OAuth refresh token in Supabase Vault, and
 * record the access-token expiry on the connection row. Used by providers
 * whose access tokens expire (e.g. Kroger). The connection row must already
 * exist — call storeIntegrationToken first.
 */
export async function storeIntegrationRefreshToken(params: {
  userId: string
  providerId: string
  refreshToken: string
  expiresAt?: string | null
}): Promise<void> {
  const admin = getAdminClient()

  const { error } = await admin.rpc('store_integration_refresh_token', {
    p_user_id:       params.userId,
    p_provider_id:   params.providerId,
    p_refresh_token: params.refreshToken,
    p_expires_at:    params.expiresAt ?? null,
  })

  if (error) {
    throw new Error(
      `[Vault] Failed to store refresh token for provider "${params.providerId}": ${error.message}`
    )
  }
}

/**
 * Retrieve and decrypt a stored refresh token from Vault.
 * Returns null if the connection has no refresh token (e.g. OwnerRez,
 * which never expires and never has one).
 */
export async function readIntegrationRefreshToken(
  userId: string,
  providerId: string
): Promise<string | null> {
  const admin = getAdminClient()

  const { data: token, error } = await admin.rpc('read_integration_refresh_token', {
    p_user_id:     userId,
    p_provider_id: providerId,
  })

  if (error) {
    throw new Error(
      `[Vault] Failed to read refresh token for provider "${providerId}": ${error.message}`
    )
  }

  return token as string | null
}

/**
 * Look up a FieldStay user ID by their external provider user ID.
 * Used by the webhook handler to find the right user when OwnerRez
 * sends a revocation event that only includes the OwnerRez user_id.
 */
export async function findUserByExternalId(
  providerId: string,
  externalUserId: string
): Promise<string | null> {
  const admin = getAdminClient()

  const { data, error } = await admin
    .from('integration_connections')
    .select('user_id')
    .eq('provider_id', providerId)
    .eq('external_user_id', externalUserId)
    .eq('status', 'active')
    .single()

  if (error || !data) return null

  return data.user_id as string
}

// ── Marketplace install: pending links ──────────────────────────────────────
// Holds an already-exchanged token for a user with no FieldStay session yet
// (arriving from a provider's marketplace) until they finish signing up.
// See supabase/migrations/*_marketplace_pending_integration_links.sql.

/**
 * Store an already-exchanged token in Vault under a random claim token,
 * for a user who doesn't have a FieldStay account/session yet. Returns the
 * pending_link_token to embed in the post-signup redirect URL.
 */
export async function holdPendingIntegrationToken(params: {
  providerId: string
  externalUserId: string
  accessToken: string
  refreshToken?: string
  scope?: string
  metadata?: Record<string, unknown>
}): Promise<string> {
  const admin = getAdminClient()
  const pendingLinkToken = randomBytes(32).toString('hex')

  const { error } = await admin.rpc('create_pending_integration_link', {
    p_pending_link_token: pendingLinkToken,
    p_provider_id:        params.providerId,
    p_external_user_id:   params.externalUserId,
    p_access_token:       params.accessToken,
    p_refresh_token:      params.refreshToken ?? null,
    p_scope:              params.scope ?? null,
    p_metadata:           params.metadata ?? {},
  })

  if (error) {
    throw new Error(
      `[Vault] Failed to hold pending token for provider "${params.providerId}": ${error.message}`
    )
  }

  return pendingLinkToken
}

/**
 * Complete a marketplace install: link a previously-held pending token to a
 * real FieldStay user now that they have an account. Single-use — returns
 * null if the token doesn't exist or already expired (30 min TTL).
 */
export async function claimPendingIntegrationLink(
  pendingLinkToken: string,
  userId: string
): Promise<{ providerId: string; externalUserId: string; orgId: string | null } | null> {
  const admin = getAdminClient()

  const { data, error } = await admin.rpc('claim_pending_integration_link', {
    p_pending_link_token: pendingLinkToken,
    p_user_id:            userId,
  })

  if (error) {
    throw new Error(`[Vault] Failed to claim pending integration link: ${error.message}`)
  }

  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null

  return {
    providerId:     row.provider_id as string,
    externalUserId: row.external_user_id as string,
    orgId:          (row.org_id as string | null) ?? null,
  }
}
