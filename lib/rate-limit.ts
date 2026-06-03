import { Redis } from '@upstash/redis'

const redis = new Redis({
  url:   process.env.upstash_fieldstay_KV_REST_API_URL!,
  token: process.env.upstash_fieldstay_KV_REST_API_TOKEN!,
})

interface RateLimitResult {
  allowed:   boolean
  remaining: number
  resetAt:   Date
}

/**
 * Sliding window rate limiter.
 * key     — unique identifier (e.g. `repuguard:${userId}`)
 * limit   — max requests per window
 * windowS — window size in seconds
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowS: number
): Promise<RateLimitResult> {
  const now      = Date.now()
  const resetAt  = new Date(now + windowS * 1000)

  try {
    const count = await redis.incr(key)
    if (count === 1) {
      await redis.expire(key, windowS)
    }
    return {
      allowed:   count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt,
    }
  } catch {
    // KV unavailable (local dev) — allow the request
    return { allowed: true, remaining: limit, resetAt }
  }
}
