import { getRedisIfConfigured } from '@/lib/redis'
import { withTimeout, REDIS_TIMEOUT_MS, isTimeoutError } from '@/lib/http/timeout'

// ============================================================================
// One expensive producer per key, across every concurrent caller and every
// serverless instance.
//
// The failure this prevents is the cache stampede. A cache-aside read
// (`get` → miss → `fetch` → `set`) has a window between the miss and the write
// in which every other caller also misses, so N concurrent requests for the
// same key produce N identical outbound calls. It is worst at exactly the
// moment you can least afford it: a TTL boundary, when demand for that key is
// by definition high, or a cold key hit by a burst.
//
// Two call sites had this shape already and neither shared an implementation:
// hospitable-token.ts (since 2026-07) and kroger-token.ts (added when an
// external audit flagged it). lib/weather/tomorrow.ts had none at all. This
// module is that pattern extracted ONCE, because the third near-copy is how
// the first two drift apart.
//
// ── Fails OPEN, deliberately ────────────────────────────────────────────────
//
// No Redis (the free plan is production-only, so every preview deploy) or a
// Redis error means "acquired": the caller produces. Losing the lock degrades
// to the pre-lock behaviour, which is a redundant call. Failing closed would
// mean a Redis blip stops every guidebook page from rendering weather and every
// token from refreshing — turning a cache outage into a total one. Same call as
// lib/integrations/circuit-breaker.ts, and the opposite of the SMS nudge
// budget, where the ceiling IS the correctness property.
//
// UNCONFIGURED REDIS MEANS ZERO STAMPEDE PROTECTION, NOT DEGRADED PROTECTION —
// every concurrent caller sees `acquired: true` and calls produce()
// independently, in every preview deploy. This is the accepted cost of failing
// open rather than a gap this file closes: reporting it per call would
// reproduce the exact CUSHION-D/E/H noise (one Sentry event per doomed
// attempt, every preview deploy) that lib/redis.ts's own header was written
// to eliminate. A caller whose produce() hits a real paid API under load is
// the one place this tradeoff actually costs something, and that is a
// call-site decision (rate limit the caller, or gate on upstashConfigured()
// itself), not something this generic module can know to flag.
// ============================================================================

/** Long enough for one slow producer, short enough that a crash self-heals. */
const DEFAULT_LOCK_TTL_SECONDS = 15

/** How long a loser waits before re-reading, and how many times. */
const DEFAULT_WAIT_MS   = 300
const DEFAULT_MAX_WAITS = 3

/**
 * Try to become the single producer for `key`.
 *
 * Returns true when the caller holds the lock AND when the lock could not be
 * consulted — see the fail-open note above. A false return means someone else
 * is producing right now.
 */
export async function acquireLock(
  key:        string,
  ttlSeconds: number = DEFAULT_LOCK_TTL_SECONDS,
): Promise<boolean> {
  const redis = getRedisIfConfigured()
  if (!redis) return true

  try {
    return (await withTimeout(() => redis.set(key, '1', { nx: true, ex: ttlSeconds }), REDIS_TIMEOUT_MS, `acquireLock(${key})`)) === 'OK'
  } catch (err) {
    // A slow-not-down Redis lands here via withTimeout's TimeoutError the
    // same as a genuine error would — see REDIS_TIMEOUT_MS's header. Either
    // way, fail open: same call as a Redis outage.
    if (!isTimeoutError(err)) {
      console.warn(`[single-flight] lock unavailable for ${key}, proceeding unlocked:`, err)
    }
    return true
  }
}

/**
 * A plain read of whether `key` is currently held — does not attempt to
 * acquire it, and never releases anything.
 *
 * For a caller that wants to know "is someone else working on this right
 * now" WITHOUT taking a turn at the lock itself — e.g. a top-level Inngest
 * step deciding whether to `step.sleep` before a later step tries the real
 * acquire/produce/release cycle. Fails open (reports "not held") on a Redis
 * error or when Redis is unconfigured, same posture as acquireLock: a stale
 * "not held" reading costs a redundant attempt downstream, not a correctness
 * failure, and failing closed here would block that caller on a Redis blip
 * for a lock that may not even be real.
 */
export async function isLockHeld(key: string): Promise<boolean> {
  const redis = getRedisIfConfigured()
  if (!redis) return false

  try {
    return (await withTimeout(() => redis.get(key), REDIS_TIMEOUT_MS, `isLockHeld(${key})`)) !== null
  } catch (err) {
    if (!isTimeoutError(err)) {
      console.warn(`[single-flight] lock-check unavailable for ${key}, assuming unheld:`, err)
    }
    return false
  }
}

/** Release early so the next caller doesn't wait out the TTL. Never throws. */
export async function releaseLock(key: string): Promise<void> {
  const redis = getRedisIfConfigured()
  if (!redis) return

  try {
    await withTimeout(() => redis.del(key), REDIS_TIMEOUT_MS, `releaseLock(${key})`)
  } catch {
    // Non-fatal — the TTL expires it (or a slow release just landed late).
  }
}

export interface SingleFlightOptions<T> {
  /** Identifies the shared work. The lock key is derived from it. */
  key: string
  /** Read whatever the winner will have written. Null/undefined = not there yet. */
  read: () => Promise<T | null | undefined>
  /** The expensive call. MUST write its result where `read` will find it. */
  produce: () => Promise<T>
  lockTtlSeconds?: number
  waitMs?:         number
  maxWaits?:       number
}

/**
 * Read-through with one producer per key.
 *
 * ```ts
 * const weather = await singleFlight({
 *   key:     cacheKey,
 *   read:    () => redis.get<WeatherContext>(cacheKey),
 *   produce: () => fetchAndCacheWeather(lat, lng, cacheKey),
 * })
 * ```
 *
 * A caller that loses the lock waits and re-reads rather than producing. If the
 * value still is not there after `maxWaits`, it produces anyway: the winner may
 * have crashed, and a duplicate call is better than an error. That fallback is
 * what keeps this an optimisation rather than a new way to fail.
 *
 * `read` is called BEFORE the lock is taken, so the common case (a warm cache)
 * costs exactly one round-trip and no lock traffic at all.
 */
export async function singleFlight<T>(opts: SingleFlightOptions<T>): Promise<T> {
  const cached = await opts.read()
  if (cached !== null && cached !== undefined) return cached

  const lockKey  = `${opts.key}:lock`
  const acquired = await acquireLock(lockKey, opts.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS)

  if (!acquired) {
    const baseWaitMs = opts.waitMs   ?? DEFAULT_WAIT_MS
    const maxWaits   = opts.maxWaits ?? DEFAULT_MAX_WAITS
    const lockTtl    = opts.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS

    for (let i = 0; i < maxWaits; i++) {
      // Jittered, not a fixed interval: every loser that lost the race at
      // roughly the same wall-clock moment is otherwise on the IDENTICAL
      // wait schedule, so if the winner's produce() takes longer than the
      // full wait budget (plausible for a real external call under load —
      // exactly the situation this module exists to protect), every one of
      // them falls through to produce() within the same narrow window right
      // after the budget expires — a fresh, simultaneous stampede, worse
      // than no lock at all because it also added latency first.
      // eslint-disable-next-line no-restricted-properties -- desynchronise waiters, not id/token generation
      const waitMs = baseWaitMs * (1 + Math.random() * 0.5) // NOSONAR -- timing jitter only, not security-sensitive (see eslint-disable justification above)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      const settled = await opts.read()
      if (settled !== null && settled !== undefined) return settled
    }

    // Wait budget exhausted with nothing to read. Try ONCE more to become
    // the winner before falling through unconditionally — the original
    // holder may have crashed, in which case its lock has already expired
    // (or another waiter released it after a failed produce()), and taking
    // over here is a real single-flight rather than every waiter producing
    // independently at the same moment.
    if (await acquireLock(lockKey, lockTtl)) {
      try {
        return await opts.produce()
      } finally {
        await releaseLock(lockKey)
      }
    }

    // Still held by someone else. Produce rather than fail — but do NOT
    // release a lock we never held.
    return opts.produce()
  }

  try {
    return await opts.produce()
  } finally {
    await releaseLock(lockKey)
  }
}

export const SINGLE_FLIGHT_DEFAULTS = {
  DEFAULT_LOCK_TTL_SECONDS,
  DEFAULT_WAIT_MS,
  DEFAULT_MAX_WAITS,
} as const
