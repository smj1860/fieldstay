// lib/integrations/providers/hostex-token.ts
// ============================================================================
// Hostex token lifecycle management.
//
// Access tokens expire every 7 days; the token endpoint rotates the refresh
// token on every use. Nothing else renews them: readIntegrationToken() is a
// plain Vault read with no reactive refresh, so without this module a Hostex
// connection is simply dead seven days after connect — and because Hostex has
// no revocation webhook (see hostex.ts's header), the row would still read
// status = 'active' the whole time.
//
// Deliberately THIN. The exchange itself is not re-implemented here the way
// hospitable-token.ts re-implements Hospitable's: it delegates to
// hostexProvider.refreshAccessToken(), which already owns the endpoint, the
// timeout budget and — the part that matters — parseHostexTokenResponse's two
// unconfirmed envelope branches. A second copy of that parse is a second place
// to fix when the real shape is confirmed, and the copy that gets missed is
// the one on the path nobody exercises until day seven.
//
// SECURITY: never log token values. Server-side only.
// ============================================================================

import 'server-only'

import { NonRetriableError } from 'inngest'

import { createServiceClient } from '@/lib/supabase/server'
import { SYNCABLE_CONNECTION_STATUSES } from '@/lib/integrations/connection-metadata'
import { reportError }         from '@/lib/observability/report-error'
import { unwrap }              from '@/lib/supabase/unwrap'
import { acquireRefreshLock, releaseRefreshLock } from '@/lib/integrations/refresh-lock'
import {
  readIntegrationToken,
  readIntegrationRefreshToken,
  storeIntegrationToken,
  storeIntegrationRefreshToken,
} from '@/lib/integrations/vault'
import { hostexProvider, HostexOAuthError } from '@/lib/integrations/providers/hostex'

const HOSTEX_PROVIDER_ID = 'hostex'

/**
 * Refresh this far ahead of expiry. Generous relative to Hospitable's 30
 * minutes because the token lives 7 days: a sync that starts just inside the
 * window should never have the token die mid-run.
 */
const REFRESH_WINDOW_MINUTES = 120

const REFRESH_LOCK_WAIT_MS   = 250
const REFRESH_LOCK_MAX_WAITS = 60   // ~15s ceiling

function shouldRefresh(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  return Date.now() >= new Date(expiresAt).getTime() - REFRESH_WINDOW_MINUTES * 60 * 1_000
}

/**
 * A valid Hostex access token for `userId`, refreshing first if it is expired
 * or close to it. This is what the sync functions call — never
 * readIntegrationToken() directly, which returns whatever is in Vault
 * including a token that expired days ago.
 *
 * Lock-wrapped, unlike the cron path: several sync steps can run for one
 * connection at once, and Hostex ROTATES the refresh token on every use, so
 * two interleaved exchanges leave the loser's superseded token in Vault and
 * the connection dies at the next refresh. A caller that loses the race polls
 * the connection row rather than starting a second exchange.
 */
export async function getValidHostexToken(userId: string): Promise<string> {
  const admin = createServiceClient({ system: 'lib/integrations/providers/hostex-token' })

  const connRes = await admin
    .from('integration_connections')
    .select('expires_at, external_user_id')
    .eq('user_id',     userId)
    .eq('provider_id', HOSTEX_PROVIDER_ID)
    // Includes 'error'. A failed refresh sets status='error', and this lookup
    // used to filter to 'active' — so the very next call threw "No active
    // connection ... Reconnect required" and NOTHING ever attempted the refresh
    // that would have healed it (store_integration_token sets status back to
    // 'active' on success). One transient refresh failure was therefore
    // permanent. 'revoked' stays excluded: that one really does need a human.
    .in('status',      [...SYNCABLE_CONNECTION_STATUSES])
    .maybeSingle()

  const connection = unwrap(connRes, { site: 'lib.integrations.hostex-token.connection' })

  if (!connection) {
    throw new NonRetriableError(`[Hostex] No active connection for user ${userId}. Reconnect required.`)
  }

  const externalUserId = connection.external_user_id ?? ''

  if (!shouldRefresh(connection.expires_at)) {
    const token = await readIntegrationToken(userId, HOSTEX_PROVIDER_ID)
    if (token) return token
    // Connection row exists but the Vault secret is gone — treat as expired.
  }

  return refreshHostexTokenLocked(userId, externalUserId)
}

async function refreshHostexTokenLocked(userId: string, externalUserId: string): Promise<string> {
  const acquired = await acquireRefreshLock('hostex', userId)

  if (acquired) {
    try {
      return await refreshHostexToken(userId, externalUserId)
    } finally {
      await releaseRefreshLock('hostex', userId)
    }
  }

  const admin = createServiceClient({ system: 'lib/integrations/providers/hostex-token' })

  for (let i = 0; i < REFRESH_LOCK_MAX_WAITS; i++) {
    await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_WAIT_MS))

    const connRes = await admin
      .from('integration_connections')
      .select('expires_at')
      .eq('user_id',     userId)
      .eq('provider_id', HOSTEX_PROVIDER_ID)
      // Includes 'error'. A failed refresh sets status='error', and this lookup
    // used to filter to 'active' — so the very next call threw "No active
    // connection ... Reconnect required" and NOTHING ever attempted the refresh
    // that would have healed it (store_integration_token sets status back to
    // 'active' on success). One transient refresh failure was therefore
    // permanent. 'revoked' stays excluded: that one really does need a human.
    .in('status',      [...SYNCABLE_CONNECTION_STATUSES])
      .maybeSingle()

    const connection = unwrap(connRes, { site: 'lib.integrations.hostex-token.expiry' })

    if (connection && !shouldRefresh(connection.expires_at)) {
      const token = await readIntegrationToken(userId, HOSTEX_PROVIDER_ID)
      if (token) return token
    }
  }

  console.warn(`[Hostex] refresh lock wait ceiling hit for user ${userId} — lock holder likely died, proceeding unlocked`)
  return refreshHostexToken(userId, externalUserId)
}

/**
 * Force-refresh the Hostex access + refresh token pair for `userId`.
 *
 * Called by integrationTokenRefreshHandler directly (unlocked, matching
 * hospitable-token.ts's cron path — the handler already serializes on
 * (user_id, provider_id) via its concurrency key) and by
 * getValidHostexToken() through refreshHostexTokenLocked(), which DOES take
 * the lock because several sync steps can race for one connection.
 *
 * @param userId          FieldStay user UUID
 * @param externalUserId  the stored Hostex identity proxy. Passed through
 *                        because storeIntegrationToken UPSERTs the connection
 *                        row — omitting it would blank the stored value.
 * @throws NonRetriableError when Hostex rejects the grant outright (the
 *         connection needs a human to reconnect); a plain Error for anything
 *         transient, so Inngest retries with backoff.
 */
export async function refreshHostexToken(
  userId:         string,
  externalUserId: string,
): Promise<string> {
  const currentRefreshToken = await readIntegrationRefreshToken(userId, HOSTEX_PROVIDER_ID)

  if (!currentRefreshToken) {
    // Nothing to exchange and nothing a retry can conjure up.
    throw new NonRetriableError(
      `[Hostex] No refresh token in Vault for user ${userId}. User must re-authorize.`,
    )
  }

  let result
  try {
    result = await hostexProvider.refreshAccessToken!({ refreshToken: currentRefreshToken })
  } catch (err) {
    // A non-zero error_code from the token endpoint means Hostex evaluated the
    // grant and refused it — a rotated-away, revoked or expired refresh token.
    // Retrying sends the same dead token again, so this is terminal: the
    // handler marks the connection revoked and emails the PM once.
    //
    // Everything else (timeout, 5xx, non-JSON, DNS) never carries an
    // error_code and is re-thrown as-is for Inngest to retry. Treating an
    // outage as terminal would tell every Hostex PM to reconnect a connection
    // that was fine.
    if (err instanceof HostexOAuthError) {
      await markConnectionError(userId)
      throw new NonRetriableError(`[Hostex] Token refresh rejected for user ${userId}: ${err.message}`)
    }
    throw err
  }

  // storeIntegrationToken UPSERTs the connection row — pass the existing
  // externalUserId through so the stored value survives the write.
  await storeIntegrationToken({
    userId,
    providerId:  HOSTEX_PROVIDER_ID,
    accessToken: result.accessToken,
    externalUserId,
    metadata:    {},
  })

  // No new refresh token means the next cycle would re-send the current one.
  // Hostex is documented to rotate, so treat its absence as a real anomaly
  // rather than quietly keeping the old value: log it, keep what we have.
  if (result.refreshToken) {
    await storeIntegrationRefreshToken({
      userId,
      providerId:   HOSTEX_PROVIDER_ID,
      refreshToken: result.refreshToken,
      expiresAt:    result.expiresAt,
    })
  } else {
    console.warn(
      `[Hostex] refresh response carried no refresh_token for user ${userId} — ` +
      `keeping the existing one. expires_at not advanced, so the cron will retry next window.`,
    )
  }

  return result.accessToken
}

async function markConnectionError(userId: string): Promise<void> {
  const admin = createServiceClient({ system: 'lib/integrations/providers/hostex-token' })
  const { error } = await admin
    .from('integration_connections')
    .update({ status: 'error', updated_at: new Date().toISOString() })
    .eq('user_id',     userId)
    .eq('provider_id', HOSTEX_PROVIDER_ID)

  if (error) {
    console.error(`[Hostex] Failed to mark connection error for user ${userId}:`, error.message)
    reportError(error, { site: 'lib.integrations.hostex-token.markConnectionError' })
  }
}
