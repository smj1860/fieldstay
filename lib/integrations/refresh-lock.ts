import { acquireLock, releaseLock } from '@/lib/cache/single-flight'

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

/** Long enough for one token exchange, short enough that a crash self-heals. */
const LOCK_TTL_SECONDS = 15

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
