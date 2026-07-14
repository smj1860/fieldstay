// lib/integrations/providers/hospitable-token.ts
// ============================================================
// Hospitable token lifecycle management.
//
// Access tokens expire every 12 hours (expires_in: 43200).
// Refresh tokens expire after 90 days.
//
// Rotation safety (per Hospitable docs):
//   Old refresh token stays valid for up to 60 min after rotation.
//   We retry once with the same refresh token on first failure — if
//   the exchange succeeded but the Vault write failed, a retry with
//   the same refresh token will still succeed in that 60-min window.
//
// SECURITY: Never log token values. Server-side only.
// ============================================================

import { createServiceClient }         from '@/lib/supabase/server'
import {
  readIntegrationToken,
  readIntegrationRefreshToken,
  storeIntegrationToken,
  storeIntegrationRefreshToken,
} from '@/lib/integrations/vault'

const HOSPITABLE_TOKEN_URL   = 'https://auth.hospitable.com/oauth/token'
const HOSPITABLE_PROVIDER_ID = 'hospitable'
const REFRESH_WINDOW_MINUTES = 30

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a valid Hospitable Bearer token for `userId`.
 * Transparently refreshes if within 30 min of expiry or already expired.
 *
 * @throws Error if no active connection exists or if all refresh attempts fail.
 */
export async function getValidHospitableToken(userId: string): Promise<string> {
  const admin = getAdminClient()

  const { data: connection, error: connErr } = await admin
    .from('integration_connections')
    .select('expires_at, external_user_id')
    .eq('user_id',     userId)
    .eq('provider_id', HOSPITABLE_PROVIDER_ID)
    .eq('status',      'active')
    .single()

  if (connErr || !connection) {
    throw new Error(
      `[Hospitable] No active connection for user ${userId}. Reconnect required.`
    )
  }

  if (!shouldRefresh(connection.expires_at)) {
    const token = await readIntegrationToken(userId, HOSPITABLE_PROVIDER_ID)
    if (!token) {
      // Connection row exists but Vault secret was deleted — treat as expired
      return refreshHospitableToken(userId, connection.external_user_id ?? '')
    }
    return token
  }

  return refreshHospitableToken(userId, connection.external_user_id ?? '')
}

/**
 * Force-refresh the Hospitable access + refresh token pair for `userId`.
 * Called by the weekly cron regardless of current expiry state.
 *
 * @param userId          FieldStay user UUID
 * @param externalUserId  Hospitable account UUID — must be passed to avoid
 *                        overwriting the stored value with an empty string in
 *                        storeIntegrationToken, which UPSERTs the connection row.
 */
export async function refreshHospitableToken(
  userId:         string,
  externalUserId: string
): Promise<string> {
  const clientId     = process.env.HOSPITABLE_CLIENT_ID
  const clientSecret = process.env.HOSPITABLE_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Missing HOSPITABLE_CLIENT_ID or HOSPITABLE_CLIENT_SECRET')
  }

  const currentRefreshToken = await readIntegrationRefreshToken(
    userId,
    HOSPITABLE_PROVIDER_ID
  )

  if (!currentRefreshToken) {
    throw new Error(
      `[Hospitable] No refresh token in Vault for user ${userId}. ` +
      `User must re-authorize.`
    )
  }

  // Attempt exchange with one retry.
  // No sleep between attempts — Hospitable's 60-min old-token window is about
  // keeping the previous token as a usable fallback, not about timing delays.
  let result: HospitableTokenResponse | null = null
  let lastError: Error | null                = null

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await exchangeRefreshToken({ clientId, clientSecret, refreshToken: currentRefreshToken })
      break
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  if (!result) {
    await markConnectionError(userId)
    throw new Error(
      `[Hospitable] Token refresh failed after 2 attempts for user ${userId}: ` +
      (lastError?.message ?? 'unknown')
    )
  }

  const newExpiresAt = new Date(Date.now() + result.expires_in * 1000).toISOString()

  // storeIntegrationToken UPSERTs the connection row — pass the existing
  // externalUserId to prevent overwriting the stored Hospitable account UUID.
  await storeIntegrationToken({
    userId,
    providerId:     HOSPITABLE_PROVIDER_ID,
    accessToken:    result.access_token,
    externalUserId,
    metadata:       {},
  })

  await storeIntegrationRefreshToken({
    userId,
    providerId:   HOSPITABLE_PROVIDER_ID,
    refreshToken: result.refresh_token,
    expiresAt:    newExpiresAt,
  })

  return result.access_token
}

// ── Internal ─────────────────────────────────────────────────────────────────

interface HospitableTokenResponse {
  access_token:  string
  refresh_token: string
  expires_in:    number
  token_type:    string
}

async function exchangeRefreshToken(params: {
  clientId:     string
  clientSecret: string
  refreshToken: string
}): Promise<HospitableTokenResponse> {
  const response = await fetch(HOSPITABLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id:     params.clientId,
      client_secret: params.clientSecret,
      grant_type:    'refresh_token',
      refresh_token: params.refreshToken,
    }),
  })

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json() as { error?: string; error_description?: string }
      detail     = body.error_description ?? body.error ?? detail
    } catch { /* ignore parse failure */ }
    throw new Error(`Hospitable token refresh returned: ${detail}`)
  }

  const data = await response.json() as HospitableTokenResponse

  if (!data.access_token || !data.refresh_token) {
    throw new Error('Hospitable refresh response missing access_token or refresh_token')
  }

  return data
}

function shouldRefresh(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  const windowMs = REFRESH_WINDOW_MINUTES * 60 * 1_000
  return Date.now() >= new Date(expiresAt).getTime() - windowMs
}

async function markConnectionError(userId: string): Promise<void> {
  const admin = getAdminClient()
  await admin
    .from('integration_connections')
    .update({ status: 'error', updated_at: new Date().toISOString() })
    .eq('user_id',     userId)
    .eq('provider_id', HOSPITABLE_PROVIDER_ID)
}

function getAdminClient() {
  return createServiceClient()
}
