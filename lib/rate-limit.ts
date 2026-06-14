import { Ratelimit } from '@upstash/ratelimit'
import { Redis }     from '@upstash/redis'

const redis = new Redis({
  url:   process.env.upstash_fieldstay_KV_REST_API_URL!,
  token: process.env.upstash_fieldstay_KV_REST_API_TOKEN!,
})

export const repuguardLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(50, '24 h'),
  analytics: true,
  prefix:    'repuguard',
})

export const scanLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(20, '24 h'),  // 20 scans/user/day
  analytics: true,
  prefix:    'scan-data-plate',
})

// Max 1 manual OwnerRez sync trigger per org per 60 seconds.
// Prevents a panicking PM from hammering the button and burning API quota.
export const syncNowLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(1, '60 s'),
  analytics: true,
  prefix:    'ownerrez-sync-now',
})

// Public work order page — 20 requests per minute per IP
// Allows a contractor to refresh and interact normally, blocks enumeration
export const workOrderRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(20, '1 m'),
  analytics: false,
  prefix:    'rl:wo',
})

// Sign-off action — 5 submissions per 5 minutes per work order token
// A contractor will never legitimately submit more than once
export const signOffRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(5, '5 m'),
  analytics: false,
  prefix:    'rl:signoff',
})
