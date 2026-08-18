import { Ratelimit } from '@upstash/ratelimit'
import { getRedis, upstashConfigured } from '@/lib/redis'

// The shared client from lib/redis.ts — see that module for why there is
// exactly one. Kept as a local binding so the limiter definitions below and
// the `export { redis }` re-export are unchanged.
const redis = getRedis()

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
 *
 * Re-exported from lib/redis.ts rather than defined here: it is now consulted
 * by the SMS nudge budget, the weather cache and the OwnerRez breaker too, and
 * none of those should have to import the rate limiter to ask. The re-export
 * keeps every existing `from '@/lib/rate-limit'` import and test mock working.
 */
export { upstashConfigured }

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

/**
 * How long an OUTBOUND provider call should wait after a denied budget check.
 *
 * Not the same question as retryAfterSeconds(), which answers "when does the
 * window reset" for an inbound Retry-After header. Here the caller is about to
 * back off a paid/limited third-party API, and the errored case is the one that
 * matters: checkLimit() sets `reset` to Date.now() when the limiter THREW, so
 * retryAfterSeconds() floors to 1 and the caller retries essentially
 * immediately — hammering a provider during the exact outage that made the
 * budget unreadable, with a fabricated retry-after that reads in logs like a
 * real provider signal ("retry after 1s").
 *
 * So an errored decision gets a real, deliberate backoff instead. A genuinely
 * exhausted window still gets its true remaining time.
 *
 * `jitter` (default true) spreads callers blocked by the SAME window so they
 * don't all re-enter the budget on one tick and re-exhaust it instantly — the
 * thundering herd that matters most when several orgs' syncs collide on a
 * platform-wide budget. Pass false where the caller is already per-connection
 * and the herd cannot form.
 *
 * Extracted from lib/kroger/client.ts, which was the ONLY one of the four
 * outbound budgets to handle `errored` at all; hospitableFetch and hostexFetch
 * both computed ~1s from the errored `reset` and are the reason this is shared
 * rather than inlined a fifth time.
 */
export const ERRORED_BUDGET_BACKOFF_SECONDS = 60

export function outboundBackoffSeconds(
  decision: LimitDecision,
  options:  { jitter?: boolean } = {},
): number {
  const base = decision.errored
    ? ERRORED_BUDGET_BACKOFF_SECONDS
    : retryAfterSeconds(decision)

  if (options.jitter === false) return base

  // eslint-disable-next-line no-restricted-properties -- retry jitter to de-synchronise blocked callers, not id/token generation
  const factor = 1 + Math.random() * 0.5 // NOSONAR -- timing jitter only, not security-sensitive
  return Math.ceil(base * factor)
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

// Proactive outbound budget for our own calls TO Hostex's API.
//
// Unlike hospitableApiLimiter, this is deliberately keyed PER CONNECTION, not
// platform-wide. Hostex's documented limits are per access token — 1,200
// req/min across all v3 endpoints and 600 req/min per endpoint (confirmed at
// api-doc.hostex.io/reference/rate-limits) — and every FieldStay org holds its
// own OAuth token, so one org's initial sync cannot consume another's quota.
// A shared bucket would invent contention Hostex does not impose. Call it as
// checkLimit(hostexApiLimiter, `hostex-api:${userId}`, …).
//
// 540/60 is 90% of the tighter per-endpoint ceiling — the same 10% headroom
// convention as hospitableApiLimiter (54/60) and OwnerRez (270/300) — so
// FieldStay throws its own RateLimitError before Hostex throttles. Hostex
// signals throttling IN-BAND (HTTP 200 with error_code 429 plus a Retry-After
// header), so the reactive half of that pair lives in hostexFetch's envelope
// check rather than in a res.status === 429 branch.
//
// THE MINUTE BUDGET ALONE IS NOT ENOUGH, which is why there is a second one
// below. Hostex enforces four windows per endpoint in parallel — 600/min,
// 6,000/5min, 10,000/hour, 50,000/day — and they are not proportional to each
// other. Spending the minute budget at its ceiling reaches 32,400 in an hour,
// three times the hourly cap. A minute-only limiter therefore says "allowed"
// for the whole of the hour in which Hostex has already started rejecting
// every call, and the throttling arrives as an in-band 429 the sync can only
// react to. Bursty traffic never notices; a large first-connect backfill
// (reviews alone are chunked into 179-day windows, each paginated) is exactly
// the shape that does.
export const hostexApiLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(540, '60 s'),
  analytics: true,
  prefix:    'hostex-api',
})

// The hourly companion: 9,000 is 90% of Hostex's 10,000/hour per-endpoint
// ceiling, same headroom convention as the minute bucket. Checked alongside
// it, never instead of it — a caller can be inside the hour and still be
// bursting past the minute.
//
// Deliberately no 5-minute or 24-hour bucket. 6,000/5min is unreachable
// without first breaching this one (9,000/hour caps a 5-minute stretch well
// under 6,000 in any sustained pattern), and 50,000/day is unreachable
// without breaching it for five straight hours — at which point the hourly
// rejection is already the signal. Two buckets that bind beat four that mostly
// duplicate each other's Redis round-trips.
export const hostexApiHourlyLimiter = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(9_000, '1 h'),
  analytics: true,
  prefix:    'hostex-api-hourly',
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

/**
 * AGGREGATE ceiling for one token-route resource, across every source IP.
 *
 * Every limiter above is keyed on the caller's IP, which bounds what any one
 * client can do and bounds nothing at all about what a *resource* can be made
 * to serve. A single leaked owner-portal URL — a forwarded email, a link in a
 * shared inbox, a crawler — hit from many IPs gives each of them its own fresh
 * per-IP allowance against the same unauthenticated, financial-data query
 * path. Load scales linearly with the number of distinct sources, and the
 * per-IP limiter never fires once.
 *
 * Keyed on the PATHNAME rather than a parsed token: the token sits at a
 * different segment on different surfaces (`/owner/{t}`, `/g/b/{t}`,
 * `/api/work-orders/{t}/…`), and the pathname already identifies the resource
 * exactly — two tokens are two pathnames, and `?month=…` on the same token is
 * correctly the same bucket.
 *
 * Deliberately well above the per-IP window: this is a ceiling on total abuse
 * of one resource, not a second per-client throttle, and it must not fire for
 * an owner and their accountant reading the same statement.
 */
export const tokenResourceRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(120, '1 m'),
  analytics: false,
  prefix:    'rl:token-resource',
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

// Provider webhook deliveries (/api/webhooks/*). These were in BYPASS_ROUTES
// with no rateLimiterForPathname branch, so they were the one externally-
// POSTable surface with no throttle at all.
//
// The exposure this bounds is specific: webhook authenticity is verified with
// an APP-LEVEL credential (Basic Auth / a shared signing secret set at app
// registration), not a per-user one, so the payload's own user_id is what
// selects whose integration token gets revoked. One leaked credential is
// therefore "revoke any tenant's integration" — and with no limiter, every
// tenant's, in a single burst.
//
// 600/min per IP is deliberately far above real delivery volume. A provider
// fans every tenant's events out from a small set of source IPs, so this
// bucket is shared across the whole platform's traffic from that provider —
// a tight limit here would drop legitimate deliveries, which for a webhook
// means a lost event, not a retried one. This is a blast-radius ceiling and
// an alerting signal, not a precision control.
export const webhookRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(600, '1 m'),
  analytics: false,
  prefix:    'rl:webhook',
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
