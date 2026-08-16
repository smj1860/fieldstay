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
import { reportError }         from '@/lib/observability/report-error'
import {
  readIntegrationRefreshToken,
  storeIntegrationToken,
  storeIntegrationRefreshToken,
} from '@/lib/integrations/vault'
import { hostexProvider, HostexOAuthError } from '@/lib/integrations/providers/hostex'

const HOSTEX_PROVIDER_ID = 'hostex'

/**
 * Force-refresh the Hostex access + refresh token pair for `userId`.
 *
 * Called by integrationTokenRefreshHandler. Not lock-wrapped, matching
 * hospitable-token.ts's cron path: the handler already serializes on
 * (user_id, provider_id) via its concurrency key, and the cron is the only
 * caller today. Phase 3's getValidHostexToken() — the sync-side accessor that
 * can genuinely race itself — is what should wrap this in
 * acquireRefreshLock('hostex', userId); that union member already exists in
 * lib/integrations/refresh-lock.ts for exactly that.
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
