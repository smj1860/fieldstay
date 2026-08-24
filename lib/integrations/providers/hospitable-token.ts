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
//
// ─────────────────────────────────────────────────────────────────────────────
// CREDENTIALS ARE NOT STEP STATE
//
// Call this from INSIDE the Inngest step that spends the token, never from a
// step of its own:
//
//   BAD   const token = await step.run('get-token', () => getValidHospitableToken(u))
//         await step.run('fetch', () => hospFetchX(token))
//
//   GOOD  await step.run('fetch', async () => hospFetchX(await getValidHospitableToken(u)))
//
// `step.run` MEMOIZES its return value. On a retry Inngest replays the earlier
// step from saved state rather than re-executing it, so the retry spends the
// SAME token the first attempt had. If that token was invalidated in the
// meantime, every retry gets the same 401 and the function exhausts its budget
// against a credential that a single re-read would have fixed.
//
// That is not hypothetical. On 2026-08-24 the hourly refresh cron rotated this
// provider's token at 09:00:07 (connection row: status active, expires_at
// 21:00:07) and hospitable-teammate-sync-handler — which had already memoized
// the previous token — 401'd until it exhausted all retries at 09:01:45,
// 98 seconds after a perfectly good token was sitting in Vault.
//
// Acquiring inside the step is cheap: the common path is one connection read
// plus one Vault read, and it only performs an exchange when the token is
// actually near expiry. It also keeps the access token out of Inngest's
// persisted step output, which is somewhere a credential has no reason to be.
//
// Enforced by unit/guardrails/token-not-in-step-state.test.ts.
// ============================================================

import { unwrap } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
import { createServiceClient }         from '@/lib/supabase/server'
import { SYNCABLE_CONNECTION_STATUSES } from '@/lib/integrations/connection-metadata'
import { acquireRefreshLock, releaseRefreshLock } from '@/lib/integrations/refresh-lock'
import { PMS_API_TIMEOUT_MS } from '@/lib/http/timeout'
import {
  readIntegrationToken,
  readIntegrationRefreshToken,
  storeIntegrationToken,
  storeIntegrationRefreshToken,
} from '@/lib/integrations/vault'

const HOSPITABLE_TOKEN_URL   = 'https://auth.hospitable.com/oauth/token'
const HOSPITABLE_PROVIDER_ID = 'hospitable'
const REFRESH_WINDOW_MINUTES = 30

// Refresh-token rotation makes concurrent refreshes for the SAME user unsafe:
// if two exchanges interleave, the loser's now-superseded refresh token is what
// ends up in Vault, and the next refresh (up to an hour later, once Hospitable's
// 60-min old-token grace expires) fails with invalid_grant. Several Inngest
// functions can hit getValidHospitableToken() for one user simultaneously, so
// the window is real, not theoretical.
//
// 20s TTL: comfortably longer than a token exchange + two Vault writes, short
// enough that a crashed holder self-heals within one Inngest step retry.
const REFRESH_LOCK_WAIT_MS     = 250
const REFRESH_LOCK_MAX_WAITS   = 60   // ~15s ceiling

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
    // Includes 'error'. A failed refresh sets status='error', and this lookup
    // used to filter to 'active' — so the very next call threw "No active
    // connection ... Reconnect required" and NOTHING ever attempted the refresh
    // that would have healed it (store_integration_token sets status back to
    // 'active' on success). One transient refresh failure was therefore
    // permanent. 'revoked' stays excluded: that one really does need a human.
    .in('status',      [...SYNCABLE_CONNECTION_STATUSES])
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
      return refreshHospitableTokenLocked(userId, connection.external_user_id ?? '')
    }
    return token
  }

  return refreshHospitableTokenLocked(userId, connection.external_user_id ?? '')
}

/**
 * Wraps refreshHospitableToken() in a short Redis lock so concurrent callers
 * for the same user don't interleave two refresh-token exchanges (Hospitable
 * rotates refresh tokens, so the loser's token is superseded and silently
 * stops working an hour later — see the REFRESH_LOCK_* comment above).
 *
 * A caller that loses the race polls the connection row instead of racing
 * the exchange itself, and only refreshes unlocked if the wait ceiling is
 * hit (the lock holder likely died mid-refresh).
 */
export async function refreshHospitableTokenLocked(
  userId:         string,
  externalUserId: string,
): Promise<string> {
  const acquired = await acquireRefreshLock('hospitable', userId)

  if (acquired) {
    try {
      return await refreshHospitableToken(userId, externalUserId)
    } finally {
      await releaseRefreshLock('hospitable', userId)
    }
  }

  const admin = getAdminClient()
  for (let i = 0; i < REFRESH_LOCK_MAX_WAITS; i++) {
    await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_WAIT_MS))

    // maybeSingle() + unwrap(): no connection is a legitimate answer, a
    // failed read is not — and both used to look the same to the refresh
    // decision below.
    const connectionRes = await admin
      .from('integration_connections')
      .select('expires_at')
      .eq('user_id',     userId)
      .eq('provider_id', HOSPITABLE_PROVIDER_ID)
      // Includes 'error'. A failed refresh sets status='error', and this lookup
    // used to filter to 'active' — so the very next call threw "No active
    // connection ... Reconnect required" and NOTHING ever attempted the refresh
    // that would have healed it (store_integration_token sets status back to
    // 'active' on success). One transient refresh failure was therefore
    // permanent. 'revoked' stays excluded: that one really does need a human.
    .in('status',      [...SYNCABLE_CONNECTION_STATUSES])
      .maybeSingle()

    const connection = unwrap(connectionRes, {
      site: 'lib.integrations.hospitable-token.expiry',
    })

    if (connection && !shouldRefresh(connection.expires_at)) {
      const token = await readIntegrationToken(userId, HOSPITABLE_PROVIDER_ID)
      if (token) return token
    }
  }

  console.warn(
    `[Hospitable] refresh lock wait ceiling hit for user ${userId} — lock holder likely died, proceeding unlocked`
  )
  return refreshHospitableToken(userId, externalUserId)
}

/**
 * Force-refresh the Hospitable access + refresh token pair for `userId`.
 * Called by the weekly cron regardless of current expiry state — deliberately
 * THE UNLOCKED ENTRY POINT. Callers outside this module should reach for
 * refreshHospitableTokenLocked() instead — including the refresh cron, which
 * used to call this directly.
 *
 * The old rationale for the cron skipping the lock was that "taking a lock the
 * cron itself would immediately contend with every other caller is a separate
 * concern from the interleaved-exchange race this lock exists to prevent."
 * Contending IS what the lock is for. The cron is simply another concurrent
 * exchange, and exempting it defeats the lock precisely when two exchanges are
 * most likely — the hourly refresh at :00 overlapping a :00 sync cron.
 *
 * The handler's `concurrency: { key: user_id + provider_id }` does not close
 * this: it serializes the cron against ITSELF, not against the sync functions,
 * which are different Inngest functions taking the Redis lock.
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
      // invalid_grant / invalid_client will not become valid on a second
      // attempt with the same token — fail fast so markConnectionError()
      // runs immediately and the PM sees "reconnect" without the extra
      // round trip.
      if (err instanceof TerminalRefreshError) break
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

/**
 * invalid_grant / invalid_client mean the refresh token itself is dead — a
 * second attempt with the same token cannot succeed. Distinguished from a
 * transient failure (network blip, 5xx) so the retry loop can fail fast.
 */
class TerminalRefreshError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerminalRefreshError'
  }
}

const TERMINAL_OAUTH_ERRORS = new Set(['invalid_grant', 'invalid_client'])

async function exchangeRefreshToken(params: {
  clientId:     string
  clientSecret: string
  refreshToken: string
}): Promise<HospitableTokenResponse> {
  const response = await fetch(HOSPITABLE_TOKEN_URL, {
    signal: AbortSignal.timeout(PMS_API_TIMEOUT_MS),
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
    let errorCode: string | undefined
    try {
      const body = await response.json() as { error?: string; error_description?: string }
      errorCode  = body.error
      detail     = body.error_description ?? body.error ?? detail
    } catch { /* ignore parse failure */ }

    if ((response.status === 400 || response.status === 401) && errorCode && TERMINAL_OAUTH_ERRORS.has(errorCode)) {
      throw new TerminalRefreshError(`Hospitable token refresh returned: ${detail}`)
    }
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
  const { error } = await admin
    .from('integration_connections')
    .update({ status: 'error', updated_at: new Date().toISOString() })
    .eq('user_id',     userId)
    .eq('provider_id', HOSPITABLE_PROVIDER_ID)

  if (error) {
    console.error(`[Hospitable] Failed to mark connection error for user ${userId}:`, error.message)
    reportError(error, { site: 'lib.integrations.hospitable-token.markConnectionError' })
  }
}

function getAdminClient() {
  return createServiceClient({ system: 'lib/integrations/providers/hospitable-token' })
}
