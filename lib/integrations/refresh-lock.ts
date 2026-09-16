import { acquireLock, releaseLock, isLockHeld } from '@/lib/cache/single-flight'
import { PMS_API_TIMEOUT_MS } from '@/lib/http/timeout'

// ============================================================================
// Single-flight locking for OAuth token refreshes, shared by every provider.
//
// Without it, two concurrent jobs for the same user that both see the token
// inside its expiry window both POST to the provider's token endpoint. Some
// providers rotate the refresh token on use, so the slower exchange can land
// on an already-consumed refresh token and invalidate the connection outright.
//
// Hospitable had this pattern already (lib/integrations/providers/
// hospitable-token.ts, plus unit/lib/hospitable-token-lock.test.ts). Kroger
// did not — getValidKrogerToken() went straight to refreshKrogerToken() with
// no guard, which a scalability audit flagged. This module is that pattern
// lifted out so the second provider inherits it instead of getting a
// near-copy, which is how the first one drifts.
//
// The SETNX itself now lives in lib/cache/single-flight.ts, shared with the
// weather cache — a THIRD copy showed up when that stampede was fixed, which
// is the point at which "one more near-copy" stops being defensible. This
// module keeps only the provider key scheme and the TTL that suits a token
// exchange.
//
// ── Fails OPEN, deliberately ────────────────────────────────────────────────
//
// A Redis error (or no Upstash at all — the free plan is production-only, so
// every preview deploy) returns "acquired". Losing the lock degrades to the
// pre-lock behaviour, which is a rare race; failing closed would block every
// token refresh on the platform during a Redis blip, which is an outage. The
// lock is an optimisation against a race, not a correctness barrier — the
// opposite call from the SMS nudge budget, where the ceiling IS the
// correctness property and absence must mean "don't send".
// ============================================================================

/**
 * Long enough for one token exchange, short enough that a crash self-heals.
 *
 * Was a flat 15s — shorter than what it protects. Hospitable's and Hostex's
 * OWN token-endpoint fetch is allowed to run for the full PMS_API_TIMEOUT_MS
 * (30s; see hospitable-token.ts's and hostex.ts's `AbortSignal.timeout(...)`
 * calls), so a legitimately-slow-but-still-working exchange could outlive
 * this Redis lock's TTL, expire it, and let a second concurrent caller start
 * a second exchange against the same (about to be rotated) refresh token —
 * exactly the interleaving this lock exists to prevent. +10s margin on top
 * covers the Vault reads/writes and connection-status update that wrap the
 * fetch itself. Same formula hostex-token.ts already uses for its own wait
 * ceiling (REFRESH_LOCK_MAX_WAITS).
 */
const LOCK_TTL_SECONDS = Math.ceil((PMS_API_TIMEOUT_MS + 10_000) / 1_000)

export type RefreshLockProvider = 'hospitable' | 'kroger' | 'ownerrez' | 'hostex'

function lockKey(provider: RefreshLockProvider, userId: string): string {
  return `${provider}:refresh-lock:${userId}`
}

/**
 * Try to become the single refresher for this (provider, user).
 *
 * Returns true when the caller holds the lock AND when the lock could not be
 * consulted — see the fail-open note above. A false return means someone else
 * is refreshing right now, and the caller should wait and re-read rather than
 * starting a second exchange.
 */
export async function acquireRefreshLock(
  provider: RefreshLockProvider,
  userId:   string,
): Promise<boolean> {
  return acquireLock(lockKey(provider, userId), LOCK_TTL_SECONDS)
}

/** Release early so the next caller doesn't wait out the TTL. Never throws. */
export async function releaseRefreshLock(
  provider: RefreshLockProvider,
  userId:   string,
): Promise<void> {
  return releaseLock(lockKey(provider, userId))
}

/**
 * A plain read of whether a refresh is CURRENTLY in progress for this
 * (provider, user) — does not attempt to acquire the lock itself. For a
 * top-level Inngest step deciding whether to `step.sleep` before any later
 * step spends a token — see lib/inngest/functions/hostex/token-lock-wait.ts.
 */
export async function isRefreshLockHeld(
  provider: RefreshLockProvider,
  userId:   string,
): Promise<boolean> {
  return isLockHeld(lockKey(provider, userId))
}
