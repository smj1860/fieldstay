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
import { tryUnwrap }            from '@/lib/supabase/unwrap'
import { acquireRefreshLock, releaseRefreshLock } from '@/lib/integrations/refresh-lock'

const PROVIDER       = 'kroger' as const
const REFRESH_WINDOW = 5 * 60 * 1_000   // refresh when < 5 min remaining

/**
 * Returns a valid Kroger access token, refreshing proactively when within
 * 5 minutes of expiry.
 */
export async function getValidKrogerToken(userId: string): Promise<string> {
  const supabase = createServiceClient({ system: 'lib/integrations/providers/kroger-token' })

  const connRes = await supabase
    .from('integration_connections')
    .select('expires_at, external_user_id')
    .eq('user_id',    userId)
    .eq('provider_id', PROVIDER)
    .maybeSingle()
  const connOut = tryUnwrap(connRes, {
    site:  'lib.integrations.kroger-token.getValidKrogerToken',
    extra: { user_id: userId },
  })
  const conn = connOut.ok ? connOut.data : null

  const expiresAt    = conn?.expires_at ? new Date(conn.expires_at) : null
  const needsRefresh =
    !expiresAt || (expiresAt.getTime() - Date.now()) < REFRESH_WINDOW

  if (needsRefresh) return await refreshKrogerTokenSingleFlight(userId)

  const token = await readIntegrationToken(userId, PROVIDER)
  if (!token)  return await refreshKrogerTokenSingleFlight(userId)
  return token
}

/**
 * refreshKrogerToken() behind the shared single-flight lock.
 *
 * Two concurrent inventory/cart_requested events for the same user near token
 * expiry both saw needsRefresh and both POSTed to Kroger's token endpoint.
 * Kroger rotates the refresh token on use, so the slower exchange can land on
 * one the faster exchange already consumed — which does not merely waste a
 * call, it can invalidate the connection.
 *
 * Hospitable has had this since 2026-07; Kroger did not, which an external
 * scalability audit flagged. Same helper now, so there is one behaviour to
 * reason about rather than two that drift.
 *
 * Losing the lock means another caller is mid-refresh: wait briefly and
 * re-read the stored token rather than starting a second exchange. If it still
 * is not there, fall through and refresh anyway — a duplicate exchange is
 * better than returning no token at all.
 */
const LOCK_WAIT_MS   = 400
const LOCK_MAX_WAITS = 5

async function refreshKrogerTokenSingleFlight(userId: string): Promise<string> {
  const acquired = await acquireRefreshLock('kroger', userId)

  if (acquired) {
    try {
      return await refreshKrogerToken(userId)
    } finally {
      await releaseRefreshLock('kroger', userId)
    }
  }

  for (let i = 0; i < LOCK_MAX_WAITS; i++) {
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS))
    const token = await readIntegrationToken(userId, PROVIDER)
    if (token) return token
  }

  return await refreshKrogerToken(userId)
}

/**
 * Refreshes the Kroger access token using the stored refresh token.
 * Throws NonRetriableError when the refresh token itself is invalid or
 * revoked — Inngest must not retry a refresh that can never succeed.
 */
export async function refreshKrogerToken(userId: string): Promise<string> {
  const supabase = createServiceClient({ system: 'lib/integrations/providers/kroger-token' })

  const connRes = await supabase
    .from('integration_connections')
    .select('external_user_id')
    .eq('user_id',    userId)
    .eq('provider_id', PROVIDER)
    .maybeSingle()
  const connOut = tryUnwrap(connRes, {
    site:  'lib.integrations.kroger-token.refreshKrogerToken',
    extra: { user_id: userId },
  })
  const conn = connOut.ok ? connOut.data : null

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
