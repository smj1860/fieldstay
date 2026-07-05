// lib/integrations/providers/kroger-token.ts
// Kroger access tokens expire in ~30 minutes. Provides reactive and
// refresh functions called by the proactive token-refresh cron.

import { createServiceClient } from '@/lib/supabase/server'
import {
  readIntegrationToken,
  readIntegrationRefreshToken,
  storeIntegrationToken,
  storeIntegrationRefreshToken,
} from '@/lib/integrations/vault'
import { refreshCustomerToken } from '@/lib/kroger/client'
import { NonRetriableError }    from 'inngest'

const PROVIDER       = 'kroger' as const
const REFRESH_WINDOW = 5 * 60 * 1_000   // refresh when < 5 min remaining

/**
 * Returns a valid Kroger access token, refreshing proactively when within
 * 5 minutes of expiry.
 */
export async function getValidKrogerToken(userId: string): Promise<string> {
  const supabase = createServiceClient()

  const { data: conn } = await supabase
    .from('integration_connections')
    .select('expires_at, external_user_id')
    .eq('user_id',    userId)
    .eq('provider_id', PROVIDER)
    .maybeSingle()

  const expiresAt    = conn?.expires_at ? new Date(conn.expires_at) : null
  const needsRefresh =
    !expiresAt || (expiresAt.getTime() - Date.now()) < REFRESH_WINDOW

  if (needsRefresh) return await refreshKrogerToken(userId)

  const token = await readIntegrationToken(userId, PROVIDER)
  if (!token)  return await refreshKrogerToken(userId)
  return token
}

/**
 * Refreshes the Kroger access token using the stored refresh token.
 * Throws NonRetriableError when the refresh token itself is invalid or
 * revoked — Inngest must not retry a refresh that can never succeed.
 */
export async function refreshKrogerToken(userId: string): Promise<string> {
  const supabase = createServiceClient()

  const { data: conn } = await supabase
    .from('integration_connections')
    .select('external_user_id')
    .eq('user_id',    userId)
    .eq('provider_id', PROVIDER)
    .maybeSingle()

  const refreshToken = await readIntegrationRefreshToken(userId, PROVIDER)
  if (!refreshToken) {
    throw new NonRetriableError(
      `[Kroger] No refresh token for user ${userId} — reconnect required`
    )
  }

  let tokens: { access_token: string; refresh_token?: string; expires_in: number }
  try {
    tokens = await refreshCustomerToken(refreshToken)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('400') || msg.includes('401')) {
      throw new NonRetriableError(
        `[Kroger] Refresh token revoked for user ${userId}: ${msg}`
      )
    }
    throw err
  }

  const expiresAt      = new Date(Date.now() + tokens.expires_in * 1_000).toISOString()
  const externalUserId = conn?.external_user_id ?? ''

  await storeIntegrationToken({
    userId,
    providerId:     PROVIDER,
    accessToken:    tokens.access_token,
    externalUserId,
    scope:          undefined,
    metadata:       {},
  })

  if (tokens.refresh_token) {
    await storeIntegrationRefreshToken({
      userId,
      providerId:   PROVIDER,
      refreshToken: tokens.refresh_token,
      expiresAt,
    })
  }

  return tokens.access_token
}
