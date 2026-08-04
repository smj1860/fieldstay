import { Ratelimit } from '@upstash/ratelimit'
import { Redis }     from '@upstash/redis'

const redis = new Redis({
  url:   process.env.upstash_fieldstay_KV_REST_API_URL!,
  token: process.env.upstash_fieldstay_KV_REST_API_TOKEN!,
})

/**
 * Exported so token-refresh paths can take a short mutual-exclusion lock.
 * Deliberately the same client instance as the limiters above — one
 * connection pool, not two.
 */
export { redis }

// ─── The one way to consult a limiter ───────────────────────────────────────
//
// Every call site in the app goes through checkLimit(). Calling
// `someLimiter.limit(...)` directly anywhere outside this file is banned by
// unit/guardrails/public-route-rate-limiting.test.ts, because doing so is how
// four *different* accidental failure behaviours ended up shipping across 12
// hand-rolled call sites (audit 2026-07-30, M-1/M-2):
//
//   - try/catch → continue          (fail open, deliberate, documented)
//   - outer try → return {ok:true}  (fail open AND silently skip the write)
//   - outer try → 500               (fail closed by accident)
//   - no catch at all               (fail closed by accident, as a 500)
//
// and because none of them replicated proxy.ts's `upstashConfigured` guard, so
// every one of them paid @upstash/redis's internal retry/backoff against an
// undefined URL — measured at ~4.3s per request — in CI, preview deploys, and
// any environment without the KV addon.
//
// checkLimit() makes both explicit:
//   (a) unconfigured Upstash short-circuits to `allowed` with `skipped: true`,
//       never touching the network;
//   (b) `onError` names the fail policy at the call site, per limiter class:
//         'allow' — abuse/enumeration limiters. A Redis outage must not take
//                   down a public route or block legitimate work. Matches
//                   lib/rate-limit.ts's own historical behaviour and the
//                   fail-open note on proxy.ts's token-route limiter.
//         'deny'  — spend/quota ceilings (paid API calls, LLM tokens, real
//                   money). A ceiling that disappears during an outage is not
//                   a ceiling. Matches claimNudgeBudgetSlot's fail-CLOSED
//                   convention documented in CLAUDE.md.
export type LimitFailPolicy = 'allow' | 'deny'

export interface LimitDecision {
  /** True when the caller may proceed. */
  allowed:   boolean
  /** True when Upstash is unconfigured and no check was performed. */
  skipped:   boolean
  /** True when the limiter threw and `onError` decided the outcome. */
  errored:   boolean
  limit:     number
  remaining: number
  /** Epoch ms at which the window resets. `Date.now()` when skipped/errored. */
  reset:     number
}

/**
 * True when both Upstash env vars are present. Exported so a caller that
 * needs to skip surrounding work (not just the limiter call) can ask.
 */
export function upstashConfigured(): boolean {
  return (
    !!process.env.upstash_fieldstay_KV_REST_API_URL &&
    !!process.env.upstash_fieldstay_KV_REST_API_TOKEN
  )
}

export async function checkLimit(
  limiter:    Ratelimit,
  identifier: string,
  options:    {
    onError: LimitFailPolicy
    site:    string
    /**
     * Tokens this call consumes. Defaults to 1 — one call, one token.
     *
     * Pass the RECIPIENT COUNT for anything that fans out. A limiter that
     * counts calls bounds nothing when one allowed call sends to a thousand
     * people: 20 invites/hour and 20 bulk-invites/hour of 1,000 recipients
     * each are the same budget to Redis and three orders of magnitude apart in
     * what they cost us and in how much third-party mail we emit.
     */
    cost?:   number
  },
): Promise<LimitDecision> {
  if (!upstashConfigured()) {
    return { allowed: true, skipped: true, errored: false, limit: 0, remaining: 0, reset: Date.now() }
  }

  // A zero/negative cost would silently consume nothing; a fractional one is
  // meaningless to the sliding-window counter. Normalize to a whole token.
  const cost = Math.max(1, Math.floor(options.cost ?? 1))

  try {
    const { success, limit, remaining, reset } = await limiter.limit(identifier, { rate: cost })
    return { allowed: success, skipped: false, errored: false, limit, remaining, reset }
  } catch (err) {
    console.error(`[rate-limit] check failed at ${site(options.site)} — failing ${options.onError === 'allow' ? 'OPEN' : 'CLOSED'}`, err)

    // Imported lazily, not at module scope: this module is pulled into the
    // middleware bundle by proxy.ts, and a static @sentry/nextjs import there
    // would load the whole SDK on every request just to be available for a
    // path that only runs when Redis is actually down.
    void import('@/lib/observability/report-error')
      .then(({ reportError }) => reportError(err, { site: `rate-limit.${options.site}` }))
      .catch(() => { /* reporter unavailable (edge/test) — the console.error above stands */ })

    return {
      allowed:   options.onError === 'allow',
      skipped:   false,
      errored:   true,
      limit:     0,
      remaining: 0,
      reset:     Date.now(),
    }
  }
}

function site(value: string): string {
  return value.slice(0, 120)
}

/** Seconds until the window resets, floored at 1 — for a Retry-After header. */
export function retryAfterSeconds(decision: LimitDecision): number {
  return Math.max(1, Math.ceil((decision.reset - Date.now()) / 1000))
}

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

// Proactive outbound budget for our own calls TO Kroger's API — same
// rationale as hospitableApiLimiter/OwnerRez's per-IP tracker above: all
// FieldStay tenants share one Vercel deployment's outbound identity (one
// app-level Kroger client credential), so cart automation fanning out
// across orgs shares a single external quota, not a per-org one. Kroger
// publishes separate daily limits per endpoint class (confirmed against
// developer.kroger.com 2026-07-25 — Products API: 10,000 calls/day;
// Locations API: 1,600 calls/day per endpoint; Identity/profile: 5,000
// calls/day), so each endpoint class gets its own limiter here rather than
// one shared bucket, mirroring how Kroger itself enforces it. Each slides
// at 90% of the documented ceiling (10% headroom) so FieldStay throws its
// own RateLimitError before Kroger would actually 429 it — same headroom
// convention as hospitableApiLimiter (54/60) and OwnerRez (270/300) above.
// All four are called with a FIXED identifier string (not per-org) so the
// budget is genuinely shared platform-wide, same as
// hospitableApiLimiter.limit('hospitable-api').

// Products API (product search, called per below-par item during cart
// building) — 10,000/day confirmed at
// developer.kroger.com/reference/api/product-api-public.
export const krogerProductsApiLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(9_000, '1 d'),
  analytics: true,
  prefix:    'kroger-products',
})

// Locations API (nearest-store lookup on Kroger connect) — 1,600/day per
// endpoint confirmed at
// developer.kroger.com/reference/api/location-api-public.
export const krogerLocationsApiLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(1_440, '1 d'),
  analytics: true,
  prefix:    'kroger-locations',
})

// Cart API (adding matched items to the customer's cart) — ⚠️ Kroger's
// published Cart API rate limit could not be confirmed: developer.kroger.com's
// Cart API reference page is JS-rendered and didn't return limit figures via
// search/fetch at implementation time (2026-07-25); Kroger's own support
// contact (APISupport@kroger.com) would be the way to confirm it directly.
// Treating this as unverifiable for now — conservatively assumes the same
// order of magnitude as the lowest CONFIRMED figure above (Locations'
// 1,600/day) rather than guessing something higher. Revisit if real 429s
// in production logs suggest the true ceiling is different.
export const krogerCartApiLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(1_440, '1 d'),
  analytics: true,
  prefix:    'kroger-cart',
})

// OAuth token endpoint (client-credentials + customer code exchange +
// refresh) and Identity/profile lookup, combined into one budget — both are
// inherently low-volume (tokens are cached ~30min per getClientToken's own
// doc comment; profile is fetched once per connect). Kroger's Identity API
// is confirmed at 5,000 calls/day; the token endpoint itself has no
// separately published figure, so this combined bucket conservatively
// reuses the Identity figure as its basis rather than assuming an
// unconfirmed higher number for token calls specifically.
export const krogerAuthApiLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(4_500, '1 d'),
  analytics: true,
  prefix:    'kroger-auth',
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

// Owner portal (/owner/[token]) — same rationale as workOrderRatelimit: a
// UUID token makes brute-force impractical, but the route is unauthenticated
// and serves financial P&L data, so it still needs its own throttle rather
// than relying on token entropy alone.
export const ownerPortalRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(20, '1 m'),
  analytics: false,
  prefix:    'rl:owner-portal',
})

// Guest-facing guidebook routes (/g/*) — media kit signup, guest guidebook
// view, and the SMS opt-in link. All unauthenticated and token-guessable.
export const guidebookRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(30, '1 m'),
  analytics: false,
  prefix:    'rl:guidebook',
})

export const guidebookRedeemLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(30, '1 h'),  // per-IP; guests redeem a handful per stay
  prefix:    'rl:guidebook-redeem',
})

// Sponsor checkout (/api/guidebook/sponsor-checkout) — public, unauthenticated,
// gated only by a mediaKitToken, and it creates a real Stripe Checkout Session
// per call. Unthrottled that is both a Stripe API abuse vector and a token
// oracle: a valid token returns a checkout URL while an invalid one returns a
// 400, so the response distinguishes them and the token is brute-forceable at
// whatever rate Stripe will accept. 10/hour per IP is far above any real
// sponsor's signup rate.
export const guidebookSponsorCheckoutLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(10, '1 h'),
  prefix:    'rl:guidebook-sponsor-checkout',
})

// OAuth callback routes (/api/integrations/*/callback and /callback/oneclick)
// — unauthenticated by nature (the provider redirects the browser here with
// no FieldStay session). The oneclick route now stores the unexchanged
// authorization code in Vault WITHOUT any provider-side validation first
// (the exchange is deferred until post-signup), so without a throttle an
// attacker could spam garbage codes to bloat vault.secrets. 20/min per IP
// is far above any legitimate redirect rate.
export const oauthCallbackRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(20, '1 m'),
  analytics: false,
  prefix:    'rl:oauth-callback',
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

// CAN-SPAM opt-out surface (/unsubscribe/*, /api/email/unsubscribe).
// Unauthenticated by law — the opt-out must work without a login — so a
// 64-char hex token is the only credential, and this bounds guessing it. The
// write is a single UPDATE and mail clients doing RFC 8058 one-click may
// retry, so the window is generous: this is anti-enumeration, not a usage cap.
// Fails OPEN on a Redis outage (the default for the abuse limiters here): a
// degraded limiter must never be the reason someone cannot opt out, which
// would itself be the compliance failure.
export const unsubscribeRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(20, '1 m'),
  analytics: false,
  prefix:    'rl:unsubscribe',
})

// Authenticated actions that SEND EMAIL to a third party — team invites, owner
// portal links, vendor Connect invites, bulk crew invites. An auth gate proves
// WHO is sending, not HOW OFTEN: without a limiter a single authenticated member
// can drive unlimited outbound mail from our sending domain, which is both a
// spend vector and, more importantly, a way to get that domain onto blocklists
// using someone else's address as the target. Keyed per USER, since the org is
// not the thing being abused.
//
// 20/hour is far above any real invite cadence (a PM onboarding a whole team
// does it once) while making a mail-bomb loop useless. Fails OPEN like the other
// abuse limiters here: a Redis outage must not stop a PM inviting their staff.
export const emailSendActionLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(20, '1 h'),
  analytics: false,
  prefix:    'rl:email-send-action',
})

// Roadshow demo surface (/demo/*) — unauthenticated and gated only by a
// shared secret in a query string that will be printed on a QR code sitting
// on a trade-show table. /demo/enter MINTS an authenticated session and
// /demo/reset WIPES the demo org, so secret entropy alone isn't the whole
// defense: this bounds brute-forcing the key and stops anyone who photographs
// the QR code from turning reset into a denial-of-demo button mid-pitch.
// 10/min per IP is far above one person scanning a code.
export const demoRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(10, '1 m'),
  analytics: false,
  prefix:    'rl:demo',
})

// Authenticated-but-expensive export routes (/api/gdpr/export,
// /api/assets/cpa-export, /api/assets/capex-csv). An auth gate proves WHO is
// calling, not HOW OFTEN — each of these runs several service-role
// cross-org queries and/or renders a multi-page PDF, so a logged-in user
// holding down refresh is a real self-inflicted load and cost vector. 5/hour
// per user is far above any legitimate export cadence (these produce a file
// the user downloads once).
export const dataExportLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(5, '1 h'),
  analytics: false,
  prefix:    'rl:data-export',
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
