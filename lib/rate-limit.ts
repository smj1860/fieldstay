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

// Max 1 manual "Trigger Resync" per provider per org per 60 seconds.
// Prevents a panicking PM from hammering the button and burning API quota.
// Keyed by `${providerId}:${orgId}` so resyncing one integration doesn't
// throttle resyncing another.
export const integrationResyncLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(1, '60 s'),
  analytics: true,
  prefix:    'integration-resync',
})

// Proactive outbound budget for our own calls TO Hospitable's API (not an
// inbound limit on FieldStay's endpoints, unlike the others in this file).
// Hospitable's documented general API limit is ~60 requests/minute per
// vendor — ⚠️ sourced from a search AI Overview summary, not confirmed
// against Hospitable's own developer docs; treat as a working assumption
// and revisit if real 429s in production logs suggest otherwise. Slides at
// 54/60 (10% headroom) so we throw our own RateLimitError before Hospitable
// would 429 us. All FieldStay tenants share one Vercel deployment's
// outbound identity, so this is a shared budget across every org syncing
// Hospitable concurrently, mirroring the same rationale as OwnerRez's
// per-IP tracker in lib/integrations/providers/ownerrez-api.ts.
export const hospitableApiLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(54, '60 s'),
  analytics: true,
  prefix:    'hospitable-api',
})

// Public work order page — 20 requests per minute per IP
// Allows a contractor to refresh and interact normally, blocks enumeration
export const workOrderRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(20, '1 m'),
  analytics: false,
  prefix:    'rl:wo',
})

// Public vendor Stripe Connect onboarding routes (/vendor-connect/[token]/*,
// /api/vendor-connect/[token]/*) — same rationale and limit as workOrderRatelimit:
// guards against stripe_connect_token enumeration on this unauthenticated route.
export const vendorConnectRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(20, '1 m'),
  analytics: false,
  prefix:    'rl:vendor-connect',
})

// Sign-off action — 5 submissions per 5 minutes per work order token
// A contractor will never legitimately submit more than once
export const signOffRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(5, '5 m'),
  analytics: false,
  prefix:    'rl:signoff',
})

// Invite-acceptance account creation (crew-invite, accept-invite) — both
// call supabase.auth.admin.createUser(), a real account-creation operation,
// from a public unauthenticated route gated only by a UUID token. Keyed by
// IP rather than token so repeated attempts against different tokens from
// the same source still get throttled.
export const inviteAcceptRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(10, '5 m'),
  analytics: false,
  prefix:    'rl:invite-accept',
})

// Support chat — 20 messages per minute per user, plus a 100/day cap
export const supportChatLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(20, '1 m'),
  analytics: true,
  prefix:    'ratelimit:support-chat',
})

export const supportChatDailyLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(100, '1 d'),
  analytics: true,
  prefix:    'ratelimit:support-chat-daily',
})
