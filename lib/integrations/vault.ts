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

import { createClient } from '@supabase/supabase-js'

/** Service-role admin client. Instantiated fresh per call — never module-scoped. */
function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables'
    )
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  })
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
