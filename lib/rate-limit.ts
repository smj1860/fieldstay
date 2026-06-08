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
