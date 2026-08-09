import { getRedisIfConfigured } from '@/lib/redis'

// ============================================================================
// A provider-level circuit breaker for outbound integrations.
//
// The audit's headline — "no circuit breaker on ANY external integration" —
// is not accurate: OwnerRez has had a per-connection breaker since 2026-07
// (lib/inngest/functions/ownerrez/incremental-sync.ts), with an in-memory
// fallback and fail-closed semantics. But it is inline in that one function
// and keyed by connection, so nothing else can use it, and Kroger, Telnyx,
// Mapbox and Tomorrow.io genuinely have none.
//
// The failure it prevents is amplification. During a provider outage every
// independent job still calls through, waits out the full timeout budget,
// throws, and is retried by Inngest's backoff. At N concurrent orgs that is
// N x (1 + retries) full-timeout round-trips against a service that is already
// struggling — the load we add peaks exactly when the provider can least take
// it, and every one of those holds a step open for the whole timeout.
//
// ── Fails OPEN (allows the call) ────────────────────────────────────────────
//
// If Redis is unavailable or unconfigured, isCircuitOpen returns false and the
// call proceeds. A breaker is a protection against wasted work, not a
// correctness barrier: refusing all outbound integration traffic because the
// counter store is down would convert a Redis blip into a total integration
// outage. Same reasoning as lib/integrations/refresh-lock.ts, and the opposite
// of the SMS nudge budget, where the ceiling IS the correctness property.
//
// Deliberately simple: a counter with a TTL, not a half-open state machine.
// The TTL IS the half-open probe — when it lapses the next call goes through,
// and either succeeds (clearing the counter) or fails (starting a new window).
// ============================================================================

/** Consecutive failures within the window before the circuit opens. */
const FAILURE_THRESHOLD = 5

/** How long a window of failures is remembered, and so how long it stays open. */
const WINDOW_SECONDS = 60

export type BreakerProvider = 'kroger' | 'telnyx' | 'mapbox' | 'tomorrow'

function key(provider: BreakerProvider): string {
  return `circuit:${provider}:failures`
}

/**
 * How many failures are on record for this provider right now.
 *
 * Returns 0 when the breaker cannot be consulted (unconfigured or erroring) —
 * see the fail-open note above.
 *
 * Callers want the COUNT, not just a boolean, so the happy path can skip the
 * clearing DEL: with a boolean the only safe thing after a success is to
 * always DEL, which adds a pointless Redis round-trip to every single
 * successful outbound call when the counter is already empty.
 */
export async function failureCount(provider: BreakerProvider): Promise<number> {
  const redis = getRedisIfConfigured()
  if (!redis) return 0

  try {
    return (await redis.get<number>(key(provider))) ?? 0
  } catch {
    return 0
  }
}

/** True when this provider has failed enough, recently enough, to stop calling it. */
export async function isCircuitOpen(provider: BreakerProvider): Promise<boolean> {
  return (await failureCount(provider)) >= FAILURE_THRESHOLD
}

/**
 * Record a failed call. Sets the window TTL on the first failure only, so the
 * window is a fixed 60s from the FIRST failure rather than sliding forward on
 * every subsequent one — otherwise a steady trickle of failures would hold the
 * circuit open indefinitely and it could never re-probe.
 */
export async function recordFailure(provider: BreakerProvider): Promise<void> {
  const redis = getRedisIfConfigured()
  if (!redis) return

  try {
    const count = await redis.incr(key(provider))
    if (count === 1) await redis.expire(key(provider), WINDOW_SECONDS)
  } catch {
    // Non-fatal: a breaker that cannot count simply never opens.
  }
}

/** Clear the failure window after a success. */
export async function recordSuccess(provider: BreakerProvider): Promise<void> {
  const redis = getRedisIfConfigured()
  if (!redis) return

  try {
    await redis.del(key(provider))
  } catch {
    // Non-fatal — the TTL expires it.
  }
}

/** Thrown when a call is skipped because the provider's circuit is open. */
export class CircuitOpenError extends Error {
  constructor(public readonly provider: BreakerProvider) {
    super(
      `${provider} circuit is open (>= ${FAILURE_THRESHOLD} failures in the last ` +
      `${WINDOW_SECONDS}s) — skipping the call instead of adding load to a failing provider`
    )
    this.name = 'CircuitOpenError'
  }
}

export const CIRCUIT_BREAKER_CONFIG = { FAILURE_THRESHOLD, WINDOW_SECONDS } as const
