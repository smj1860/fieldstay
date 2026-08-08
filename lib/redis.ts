import { Redis } from '@upstash/redis'

// ============================================================================
// The one place an Upstash Redis client is constructed, and the one place that
// answers "is Upstash configured in this environment at all?".
//
// There were FOUR independent clients — lib/rate-limit.ts, lib/sms/telnyx.ts,
// lib/weather/tomorrow.ts and lib/integrations/providers/ownerrez-api.ts —
// each doing
//
//   new Redis({ url: process.env.upstash_..._URL!, token: ...! })
//
// and only ONE of them (checkLimit) ever asked whether those variables were
// actually set. The `!` is a lie in any environment without Upstash: the
// client constructs happily on undefined credentials and only fails at request
// time, where it builds `${baseUrl}/pipeline` = "/pipeline" and undici throws
// `TypeError: Failed to parse URL from /pipeline`.
//
// Upstash's free plan is production-only here, so every preview deploy has no
// credentials — and the OwnerRez circuit breaker called Redis three times per
// connection per tick regardless. That produced 590 Sentry events across four
// days (CUSHION-D/E/H) from a failure that was known at boot and could never
// have succeeded.
//
// ── The distinction this module exists to make ──────────────────────────────
//
// "Redis is DOWN" and "Redis was never CONFIGURED here" are different states
// and deserve opposite handling, and the callers conflated them:
//
//   down        → transient, unexpected. Degrade defensively (the breaker
//                 keeps its in-memory counter, the SMS budget fails closed),
//                 and report LOUDLY, because someone needs to know.
//   unconfigured→ permanent, expected, knowable before the call. Attempting it
//                 buys a doomed fetch, @upstash/redis's internal retries, and
//                 one Sentry event per attempt. Skip quietly and take the same
//                 degraded path.
//
// So callers ask `upstashConfigured()` FIRST and short-circuit, then keep
// their existing try/catch for the genuine-outage case. Both paths reach the
// same fallback; only the noise differs.
//
// Enforced by unit/guardrails/redis-single-client.test.ts.
// ============================================================================

/**
 * True when both Upstash env vars are present.
 *
 * Read at call time, not module load: `next build` evaluates module scope in
 * environments that do not have these set, and a cached `false` would then
 * persist into a running server that does.
 */
export function upstashConfigured(): boolean {
  return (
    !!process.env.upstash_fieldstay_KV_REST_API_URL &&
    !!process.env.upstash_fieldstay_KV_REST_API_TOKEN
  )
}

let client: Redis | null = null

/**
 * The shared client. One connection pool for the whole app.
 *
 * Lazy for the same reason lib/stripe/client.ts is: constructing at module
 * load runs during `next build`'s page-data collection, in an environment
 * without credentials.
 *
 * Callers must gate on `upstashConfigured()` before using the returned client
 * — this deliberately does NOT throw when unconfigured, because several
 * callers legitimately want to check-then-skip rather than handle an
 * exception, and because throwing here would turn a quiet degrade into the
 * loud failure the guard exists to remove.
 */
export function getRedis(): Redis {
  client ??= new Redis({
    url:   process.env.upstash_fieldstay_KV_REST_API_URL ?? '',
    token: process.env.upstash_fieldstay_KV_REST_API_TOKEN ?? '',
  })
  return client
}

/**
 * The safe accessor: the client, or null when Upstash is not configured.
 *
 * Prefer this at call sites whose only response to "no Redis" is to skip —
 * `const redis = getRedisIfConfigured(); if (!redis) return fallback` is
 * harder to get wrong than remembering a separate guard call.
 */
export function getRedisIfConfigured(): Redis | null {
  return upstashConfigured() ? getRedis() : null
}

/** Test-only: drop the memoized client so env changes take effect. */
export function __resetRedisClientForTests(): void {
  client = null
}
