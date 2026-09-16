import { getRedisIfConfigured } from '@/lib/redis'

// ============================================================================
// A provider-level circuit breaker for outbound integrations.
//
// The audit's headline — "no circuit breaker on ANY external integration" —
// was not accurate even before this file added 'hospitable'/'ownerrez':
// Kroger has used this shared breaker since it was written (lib/kroger/
// client.ts), and OwnerRez has had its OWN separate per-connection breaker
// since 2026-07 (lib/inngest/functions/ownerrez/incremental-sync.ts), with an
// in-memory fallback and fail-closed semantics. That one stays — it is inline
// in that one function's dispatch tick, keyed by CONNECTION rather than
// platform-wide, and decides whether to even attempt a given connection's
// sync at all, which this shared, platform-wide breaker cannot express.
//
// What the audit found correctly is that Mapbox, Tomorrow.io, hospitableFetch,
// hostexFetch, and OwnerRezApiClient's shared fetch transport (used by every
// OwnerRez consumer EXCEPT incremental-sync — initial-sync, reviews-sync and
// reconciliation-handler have no breaker of any kind today) genuinely had
// none. 'hospitable', 'ownerrez' and 'hostex' were added to BreakerProvider
// and wired into hospitableFetch / OwnerRezApiClient.fetchUrl / hostexFetch
// for exactly that reason — as a platform-wide, transport-level backstop that
// runs ALONGSIDE OwnerRez's existing per-connection one, not a replacement
// for it. Mapbox and Tomorrow.io are unaddressed follow-up, out of scope for
// this pass.
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
// If Redis is unavailable or unconfigured, evaluateBreaker returns 'closed'
// and the call proceeds. A breaker is a protection against wasted work, not a
// correctness barrier: refusing all outbound integration traffic because the
// counter store is down would convert a Redis blip into a total integration
// outage. Same reasoning as lib/integrations/refresh-lock.ts, and the opposite
// of the SMS nudge budget, where the ceiling IS the correctness property.
//
// ── A real half-open state, not just an expiring counter ───────────────────
//
// The original design was deliberately simple: a failure counter with a TTL,
// with the TTL itself standing in for a half-open probe — "when it lapses the
// next call goes through, and either succeeds or fails". That has a real
// thundering-herd defect: EVERY concurrent caller reads the SAME counter, so
// the instant it expires, every one of them sees 'closed' simultaneously and
// floods through at once — not one canary probe, the entire queued load. For
// Kroger (concurrency 8) that is up to 8 requests landing on a provider that
// may still be fragile, at the exact moment recovery was supposed to be
// tested gently, which can retrip the breaker before a single clean window is
// ever observed.
//
// The fix separates "is the circuit open" from the failure counter's own TTL.
// recordFailure writes an explicit `openedUntil` timestamp (the VALUE, not
// merely the key's existence) once the threshold is crossed; evaluateBreaker
// compares wall-clock time against that value rather than inferring state from
// whether a key happens to still exist. Once past `openedUntil`, exactly ONE
// caller claims the probe slot via an atomic SETNX — every other concurrent
// caller still reads 'open' until that probe's outcome (recordSuccess /
// recordFailure) resolves the circuit. A failed probe re-opens with a FRESH
// cooldown and releases the claim, so the next probe is only granted once
// that new cooldown elapses.
// ============================================================================

/** Consecutive failures within the window before the circuit opens. */
const FAILURE_THRESHOLD = 5

/** How long a window of failures is remembered, and how long the circuit stays fully open once tripped. */
const WINDOW_SECONDS = 60

/**
 * How long a claimed probe slot is held before it is assumed abandoned.
 *
 * Sized above the longest per-provider call this breaker currently guards
 * (Kroger's KROGER_TIMEOUT_MS = 15s) with margin, so a probe call that is
 * merely slow — not dead — cannot have its claim reclaimed by another caller
 * mid-flight. A crashed probe still self-heals once this TTL lapses.
 */
const PROBE_TIMEOUT_SECONDS = 20

export type BreakerProvider = 'kroger' | 'telnyx' | 'mapbox' | 'tomorrow' | 'hostex' | 'hospitable' | 'ownerrez'

function failuresKey(provider: BreakerProvider): string {
  return `circuit:${provider}:failures`
}
function openedKey(provider: BreakerProvider): string {
  return `circuit:${provider}:opened-until`
}
function probeKey(provider: BreakerProvider): string {
  return `circuit:${provider}:probe`
}

/**
 * How many failures are on record for this provider right now.
 *
 * Returns 0 when the breaker cannot be consulted (unconfigured or erroring) —
 * see the fail-open note above. Introspection only — see evaluateBreaker for
 * the function a call site should actually gate on.
 */
export async function failureCount(provider: BreakerProvider): Promise<number> {
  const redis = getRedisIfConfigured()
  if (!redis) return 0

  try {
    return (await redis.get<number>(failuresKey(provider))) ?? 0
  } catch {
    return 0
  }
}

/**
 * True when this provider has failed enough, recently enough, to be past the
 * threshold. Introspection only: unlike evaluateBreaker, this says nothing
 * about half-open/probe state, and a NEW call site should use
 * evaluateBreaker instead of building fresh logic on this boolean.
 */
export async function isCircuitOpen(provider: BreakerProvider): Promise<boolean> {
  return (await failureCount(provider)) >= FAILURE_THRESHOLD
}

export type BreakerDecision = 'closed' | 'open' | 'probe'

export interface BreakerEvaluation {
  decision: BreakerDecision
  /** The failure count BEFORE this call, so a caller can skip a pointless clearing DEL on a healthy response. */
  priorFailures: number
}

/**
 * The real gate a call site should consult before making an outbound
 * request. Returns:
 *   - 'closed' — proceed normally.
 *   - 'open'   — skip the call; the circuit is tripped and still cooling down,
 *                or another caller already holds the probe slot.
 *   - 'probe'  — proceed, but this call IS the exclusive trial attempt: its
 *                outcome (recordSuccess/recordFailure) decides whether the
 *                circuit fully closes or re-opens for a fresh cooldown.
 *
 * Fails to 'closed' when Redis is unavailable or errors — see the fail-open
 * note above.
 */
export async function evaluateBreaker(provider: BreakerProvider): Promise<BreakerEvaluation> {
  const redis = getRedisIfConfigured()
  if (!redis) return { decision: 'closed', priorFailures: 0 }

  try {
    const [rawFailures, openedUntil] = await Promise.all([
      redis.get<number>(failuresKey(provider)),
      redis.get<number>(openedKey(provider)),
    ])
    const priorFailures = rawFailures ?? 0

    if (openedUntil == null) return { decision: 'closed', priorFailures }
    if (Date.now() < openedUntil) return { decision: 'open', priorFailures }

    // Cooldown has elapsed. Try to become the exclusive probe.
    const claimed = await redis.set(probeKey(provider), '1', { nx: true, ex: PROBE_TIMEOUT_SECONDS })
    return { decision: claimed === 'OK' ? 'probe' : 'open', priorFailures }
  } catch {
    return { decision: 'closed', priorFailures: 0 }
  }
}

/**
 * Record a failed call. Sets the window TTL on the first failure only, so the
 * window is a fixed 60s from the FIRST failure rather than sliding forward on
 * every subsequent one — otherwise a steady trickle of failures would hold the
 * circuit open indefinitely and it could never re-probe.
 *
 * Crossing FAILURE_THRESHOLD (whether tripping the circuit for the first
 * time, or a probe call itself failing) writes a fresh `openedUntil` and
 * releases any probe claim, so the circuit re-opens for a full new cooldown
 * rather than immediately granting another probe.
 */
export async function recordFailure(provider: BreakerProvider): Promise<void> {
  const redis = getRedisIfConfigured()
  if (!redis) return

  try {
    const count = await redis.incr(failuresKey(provider))
    if (count === 1) await redis.expire(failuresKey(provider), WINDOW_SECONDS)

    if (count >= FAILURE_THRESHOLD) {
      // The Redis TTL here is only a cleanup safety net — the actual "is it
      // still open" decision compares wall-clock time against the stored
      // VALUE (see evaluateBreaker), not against whether this key exists.
      await redis.set(openedKey(provider), Date.now() + WINDOW_SECONDS * 1_000, {
        ex: WINDOW_SECONDS + PROBE_TIMEOUT_SECONDS,
      })
      await redis.del(probeKey(provider))
    }
  } catch {
    // Non-fatal: a breaker that cannot count simply never opens.
  }
}

/** Clear the failure window, the open marker and any probe claim after a success. */
export async function recordSuccess(provider: BreakerProvider): Promise<void> {
  const redis = getRedisIfConfigured()
  if (!redis) return

  try {
    await redis.del(failuresKey(provider))
    await redis.del(openedKey(provider))
    await redis.del(probeKey(provider))
  } catch {
    // Non-fatal — the TTLs expire them.
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

export const CIRCUIT_BREAKER_CONFIG = { FAILURE_THRESHOLD, WINDOW_SECONDS, PROBE_TIMEOUT_SECONDS } as const
