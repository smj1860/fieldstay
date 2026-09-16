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
    return (await withTimeout(redis.set(key, '1', { nx: true, ex: ttlSeconds }), REDIS_TIMEOUT_MS, `acquireLock(${key})`)) === 'OK'
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

/** Release early so the next caller doesn't wait out the TTL. Never throws. */
export async function releaseLock(key: string): Promise<void> {
  const redis = getRedisIfConfigured()
  if (!redis) return

  try {
    await withTimeout(redis.del(key), REDIS_TIMEOUT_MS, `releaseLock(${key})`)
  } catch {
    // Non-fatal — the TTL expires it (or a slow release just landed late).
  }
}

/**
 * Extends an already-held lock's TTL. Best-effort — a failure here is not
 * fatal, it just means the ORIGINAL ttlSeconds still governs when the lock
 * self-heals.
 *
 * For a guarded operation whose runtime is not fixed (a variable-sized DB
 * insert, say), a lock acquired with a fixed TTL can expire mid-operation:
 * a concurrent retry then sees the key as free, acquires it, and duplicates
 * the very write the lock exists to serialize. Calling this partway through
 * — after the slow-and-variable part of the work has started — re-arms the
 * TTL so the lock's lifetime tracks the operation's actual duration rather
 * than a guess made before it started.
 *
 * Does not throw and does not distinguish "extended" from "key already
 * gone" — a caller racing its own expiry has no correct action to take on
 * either outcome beyond finishing as fast as possible, which it was already
 * going to do.
 */
export async function renewLock(
  key:        string,
  ttlSeconds: number = DEFAULT_LOCK_TTL_SECONDS,
): Promise<void> {
  const redis = getRedisIfConfigured()
  if (!redis) return

  try {
    await withTimeout(redis.expire(key, ttlSeconds), REDIS_TIMEOUT_MS, `renewLock(${key})`)
  } catch {
    // Non-fatal — see header comment. The original TTL still applies.
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
 * Waits `maxWaits` times, jittered, re-reading after each wait. Returns the
 * first non-null/undefined read, or `undefined` if the whole cycle passes
 * with nothing to read.
 *
 * Extracted so `singleFlight` can run this cycle TWICE (see the header
 * comment on the second-stampede fix below) without duplicating the jitter
 * math — a second hand-rolled copy is exactly how the two would drift out of
 * sync with each other over time.
 */
async function waitAndPoll<T>(
  read:      () => Promise<T | null | undefined>,
  baseWaitMs: number,
  maxWaits:   number,
): Promise<T | undefined> {
  for (let i = 0; i < maxWaits; i++) {
    // Jittered, not a fixed interval: every loser that lost the race at
    // roughly the same wall-clock moment is otherwise on the IDENTICAL
    // wait schedule, so if the winner's produce() takes longer than the
    // full wait budget (plausible for a real external call under load —
    // exactly the situation this module exists to protect), every one of
    // them falls through within the same narrow window right after the
    // budget expires — a fresh, simultaneous stampede, worse than no lock
    // at all because it also added latency first.
    // eslint-disable-next-line no-restricted-properties -- desynchronise waiters, not id/token generation
    const waitMs = baseWaitMs * (1 + Math.random() * 0.5) // NOSONAR -- timing jitter only, not security-sensitive (see eslint-disable justification above)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    const settled = await read()
    if (settled !== null && settled !== undefined) return settled
  }
  return undefined
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
 *
 * ── The second-stampede fix ──────────────────────────────────────────────
 *
 * A slow-but-alive producer (a real external call under load, exactly what
 * this module exists to protect against) can outlast the FIRST wait cycle.
 * Every waiter then reaches the "try once more to acquire" step within the
 * same narrow window, and if the original holder is still working (not
 * crashed — just slow), that re-acquire fails for all of them too. Falling
 * through to `produce()` unconditionally at that point reproduces the exact
 * failure this module exists to prevent: every loser calling the expensive
 * producer at once, synchronized by having just failed the same re-acquire
 * at the same moment — a second stampede, now with the first wait's latency
 * already paid.
 *
 * So a failed re-acquire runs a SECOND bounded wait-and-poll cycle (fresh
 * jitter, same budget) before giving up. This does not fix a producer slower
 * than 2x the wait budget — nothing short of `waitForEvent`-style signalling
 * would — but it closes the common case (a producer that finishes somewhat
 * after the first budget, e.g. a provider having a slow-but-not-timed-out
 * moment) without every waiter free-running the expensive call. Callers with
 * a known-slow producer (a third-party API with a realistic multi-second
 * p99) should still size `waitMs`/`maxWaits` to their real latency rather
 * than lean on this as the only protection — this is a backstop for the
 * budget being merely a little short, not a substitute for sizing it right.
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

    const firstWait = await waitAndPoll(opts.read, baseWaitMs, maxWaits)
    if (firstWait !== undefined) return firstWait

    // First wait budget exhausted with nothing to read. Try ONCE more to
    // become the winner before falling through — the original holder may
    // have crashed, in which case its lock has already expired (or another
    // waiter released it after a failed produce()), and taking over here is
    // a real single-flight rather than every waiter producing independently
    // at the same moment.
    if (await acquireLock(lockKey, lockTtl)) {
      try {
        return await opts.produce()
      } finally {
        await releaseLock(lockKey)
      }
    }

    // Still held by someone else — a slow-but-alive producer, not a crashed
    // one. Run a SECOND bounded wait-and-poll cycle with fresh jitter rather
    // than falling through immediately: see the second-stampede note above.
    const secondWait = await waitAndPoll(opts.read, baseWaitMs, maxWaits)
    if (secondWait !== undefined) return secondWait

    // Both wait cycles exhausted and the lock is still held. Produce rather
    // than fail — but do NOT release a lock we never held.
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
