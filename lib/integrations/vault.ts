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
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type { Json } from '@/types/database'

/** Service-role admin client, routed through the one central helper. */
function getAdminClient() {
  return createServiceClient({ system: 'lib/integrations/vault' })
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
  metadata?: Record<string, Json>
}): Promise<string> {
  const admin = getAdminClient()

  // p_scope is DEFAULT NULL, so omitting it is exactly what passing null
  // meant — and it is what the generated `p_scope?: string` arg type accepts.
  const { data: secretId, error } = await admin.rpc('store_integration_token', {
    p_user_id:          params.userId,
    p_provider_id:      params.providerId,
    p_access_token:     params.accessToken,
    p_external_user_id: params.externalUserId,
    p_metadata:         params.metadata ?? {},
    ...(params.scope === undefined ? {} : { p_scope: params.scope }),
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

  // p_expires_at is DEFAULT NULL — see storeIntegrationToken above.
  const { error } = await admin.rpc('store_integration_refresh_token', {
    p_user_id:       params.userId,
    p_provider_id:   params.providerId,
    p_refresh_token: params.refreshToken,
    ...(params.expiresAt === undefined || params.expiresAt === null
      ? {}
      : { p_expires_at: params.expiresAt }),
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

// findUserByExternalId() lived here and is deleted, not merely unused.
//
// Its body was `if (error || !data) return null` — a query failure and "no
// such connection" collapsed into the same answer — and its one caller (the
// provider revocation webhook) read that null as "already disconnected",
// returned 2xx, and left a token the provider had revoked live in Vault.
//
// It also filtered .eq('status','active'), so a connection in 'error' after a
// failed token refresh resolved to nobody and never had its secret destroyed,
// and used .single() on a predicate that is NOT unique
// (integration_connections is UNIQUE (user_id, provider_id), not on
// external_user_id).
//
// The webhook now reads the connections itself, unwrapped and unfiltered by
// status, and revokes every one bound to the external account. Deleted rather
// than left dead so nothing reaches for a helper carrying all three defects —
// the same reasoning as CLAUDE.md's unreferenced-server-actions rule.

// ── Marketplace install: pending authorization codes ────────────────────────
// Holds the UNEXCHANGED OAuth authorization code for a user with no FieldStay
// session yet (arriving from a provider's marketplace) until they finish
// signing up. The code→token exchange is deferred to /connect/finish
// (post-auth) — exchanging on arrival registered the connection with the
// provider (their UI flipped to "Connected") before any FieldStay account
// existed, which is exactly the behavior Hospitable's partner team flagged.
// See supabase/migrations/20260722120000_defer_marketplace_code_exchange.sql.

/**
 * Store an unexchanged OAuth authorization code in Vault under a random
 * claim token, for a user who doesn't have a FieldStay account/session yet.
 * Returns the pending_link_token to embed in the post-signup redirect URL.
 *
 * The code is a credential — same zero-plaintext-at-rest rule as tokens.
 * redirectUri is the exact value the authorization request was issued
 * against; it is replayed on the deferred exchange for providers that
 * enforce redirect_uri matching.
 */
export async function holdPendingOAuthCode(params: {
  providerId: string
  code: string
  redirectUri: string
}): Promise<string> {
  const admin = getAdminClient()
  const pendingLinkToken = randomBytes(32).toString('hex')

  const { error } = await admin.rpc('create_pending_oauth_authorization', {
    p_pending_link_token: pendingLinkToken,
    p_provider_id:        params.providerId,
    p_authorization_code: params.code,
    p_redirect_uri:       params.redirectUri,
  })

  if (error) {
    throw new Error(
      `[Vault] Failed to hold pending authorization code for provider "${params.providerId}": ${error.message}`
    )
  }

  return pendingLinkToken
}

/**
 * Retrieve (and destroy) a previously-held authorization code now that the
 * user has an authenticated FieldStay session. Single-use — the Vault secret
 * and pending row are deleted in the same transaction that returns the code.
 * Returns null if the token doesn't exist or already expired (30 min TTL).
 *
 * The caller performs the code→token exchange immediately; if the provider
 * rejects the code (expired/already used on their side), fall back to
 * restarting the standard /connect flow — never a dead end.
 */
export async function claimPendingOAuthCode(
  pendingLinkToken: string
): Promise<{ providerId: string; code: string; redirectUri: string } | null> {
  const admin = getAdminClient()

  const { data, error } = await admin.rpc('claim_pending_oauth_authorization', {
    p_pending_link_token: pendingLinkToken,
  })

  if (error) {
    throw new Error(`[Vault] Failed to claim pending authorization code: ${error.message}`)
  }

  const row = unwrapJoin(data)
  if (!row) return null

  return {
    providerId:  row.provider_id as string,
    code:        row.authorization_code as string,
    redirectUri: row.redirect_uri as string,
  }
}

/**
 * TTL cleanup for both marketplace-install holding areas: expired unclaimed
 * authorization codes (pending_oauth_authorizations) and any leftover rows in
 * the legacy exchanged-token table (pending_integration_links — no longer
 * written to, kept through the deploy window). Deletes the rows AND their
 * Vault secrets. Invoked probabilistically from the integration routes,
 * mirroring cleanup_webhook_dedup()'s fire-on-request pattern — closes
 * FUTURE_REMEDIATION.md #7 (the legacy cleanup function existed but was
 * never called from anywhere).
 */
export async function cleanupExpiredPendingIntegrationArtifacts(): Promise<void> {
  const admin = getAdminClient()

  const [codes, links] = await Promise.all([
    admin.rpc('cleanup_expired_pending_oauth_authorizations'),
    admin.rpc('cleanup_expired_pending_integration_links'),
  ])

  if (codes.error) {
    console.warn(`[Vault] Pending authorization code TTL cleanup failed (non-fatal): ${codes.error.message}`)
  }
  if (links.error) {
    console.warn(`[Vault] Pending integration link TTL cleanup failed (non-fatal): ${links.error.message}`)
  }
}
