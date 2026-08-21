// lib/http/timeout.ts
// ============================================================================
// Per-service timeout budgets for outbound fetch() calls.
//
// A fetch() with no AbortSignal has NO timeout of its own — it hangs until
// the platform kills the whole function. That is worst on user-facing paths
// (a hung Mapbox call inside createProperty holds the property save open
// until Vercel's function timeout fires and the PM sees a generic failure),
// but it is bad everywhere: a hung call inside an Inngest step burns the
// step's whole execution budget without producing a retryable error.
//
// Budgets are per service, chosen against what that call is blocking:
//   - Anything inside a synchronous user save gets the tightest budget.
//   - Background/step-scoped calls can afford more, but never "forever".
//
// isTimeoutError() exists so callers can tell "we gave up waiting" apart
// from "the service answered with a real failure" — the two want different
// log lines and, for retrying callers, different decisions.
// ============================================================================

/** Mapbox geocode — runs inside the createProperty/updateProperty save. */
export const GEOCODE_TIMEOUT_MS = 5_000

/** Tomorrow.io realtime weather — inside the per-guest nudge SMS send. */
export const WEATHER_TIMEOUT_MS = 8_000

/** Telnyx message dispatch. */
export const SMS_TIMEOUT_MS = 10_000

/** Kroger auth/product/cart API. */
export const KROGER_TIMEOUT_MS = 15_000

/**
 * Anthropic messages API — item-name normalization inside the Kroger cart
 * builder's Inngest step. Generous relative to the others because it is a
 * token-generating call rather than a lookup, but still finite: unbounded, a
 * hung request burns the whole step budget and the cart is never built.
 */
export const ANTHROPIC_TIMEOUT_MS = 30_000

/**
 * Crew PWA → /api/assets/request-scan, from inside the Dexie outbox drain.
 *
 * The only budget here that is spent on a phone rather than a server, and it
 * holds the drain open while it runs, so it is deliberately tight: the route
 * itself only validates and hands off to Inngest (the billed Claude call
 * happens later, out of band), and a crew member on marginal signal is better
 * served by a fast failure that retries on the existing backoff than by a
 * request that hangs and blocks every later mutation behind it.
 */
export const SCAN_REQUEST_TIMEOUT_MS = 10_000

/**
 * Crew PWA → the Route Handlers the Dexie outbox posts to (turnover
 * start/complete, work-order complete, work-order reports, crew messages,
 * inventory counts).
 *
 * Same reasoning as SCAN_REQUEST_TIMEOUT_MS above, and the same drain — but
 * these six had no signal at all, and in this loop a hang is not slow, it is
 * PERMANENT:
 *
 *   pushOne() awaits uploadOne() → the fetch never settles → drain() never
 *   returns → withTabLock() never returns → processOutbox()'s try never
 *   reaches its finally → `isProcessing` stays true for the life of the page.
 *
 * Every later processOutbox() — the 30s interval, the `online` event, the kick
 * enqueueMutation() fires, the bounded flush at logout — then hits
 * `if (this.isProcessing) { redrainRequested = true; return }` and does
 * nothing. The crew member's queue never moves again.
 *
 * And it is invisible while it happens. STALLED_NETWORK_ATTEMPTS counts FAILED
 * transport attempts; a hang never fails, so networkRetryCount never
 * increments and the stalled surface never fires. FailedSyncBanner filters on
 * `failed`, which is never set. The one thing the crew member does eventually
 * see is the logout "unsynced work" dialog — with no way to resolve it.
 *
 * A mobile network that accepts the connection and then never answers — a
 * captive portal, a cell handoff, a black-holing proxy — produces exactly
 * this, and navigator.onLine stays true throughout.
 *
 * Looser than the scan budget because these routes do real work (the
 * completion routes fire Inngest events, write audit rows and notify the PM)
 * rather than validating and handing off. Still far tighter than "never".
 *
 * An abort surfaces as a DOMException whose message contains "timed out",
 * which lib/dexie/net.ts classifies as `network` — so it costs no retry
 * budget, backs off, and becomes visible through STALLED_NETWORK_ATTEMPTS.
 * That is the correct treatment for a timeout, and it only works once the
 * request can actually time out.
 */
export const CREW_OUTBOX_TIMEOUT_MS = 15_000

/**
 * Pre-caching a crew page document (lib/dexie/sync/warm-routes.ts).
 *
 * Short on purpose. This is opportunistic work awaited at the tail of
 * fullCrewResync, and the connection it runs on is by definition the marginal
 * one — a cleaner in a driveway with one bar. An untimed fetch there would
 * hang and stall the sync it is riding on; better to skip the warm and let the
 * next sync retry it.
 */
export const ROUTE_WARM_TIMEOUT_MS = 8_000

/**
 * Registering a push subscription with our own API route
 * (lib/push/subscribe-client.ts).
 *
 * Same-origin and browser-side, so an untimed call burns no serverless
 * invocation — but it does leave the mount handler that awaits it pending
 * forever, on a device whose connection is the marginal one by definition (a
 * cleaner in a driveway, a PM at a property). The re-send on the next app open
 * is what makes giving up cheap: the routes upsert, so a skipped attempt costs
 * nothing but the next mount.
 *
 * 10s rather than warm-routes' 8s because this one has a user-visible
 * consequence — the crew prompt stays open with a retry — where a warm is
 * silent and disposable.
 */
export const PUSH_SUBSCRIBE_TIMEOUT_MS = 10_000

/**
 * Stripe SDK calls. The SDK's own default is 80s — longer than the function
 * budget, so a slow call inside the webhook handler gets the whole invocation
 * killed by the platform. That skips the `catch` that releases the dedup
 * claim, and Stripe's retry then hits the still-held claim and is discarded as
 * a duplicate: the exact event loss the release exists to prevent, reached
 * through the one door it does not cover.
 */
export const STRIPE_TIMEOUT_MS = 10_000

/**
 * Budget for one Resend send.
 *
 * Enforced by RACING the SDK call rather than aborting it: Resend's
 * `PostOptions` carries only `query` — there is no `signal` anywhere in the
 * published SDK — so nothing can cancel the in-flight request. See
 * `sendWithTimeout` in lib/resend/client.ts for why abandoning an unknown-
 * outcome send is nonetheless safe here.
 *
 * Generous, because the alternative to waiting is abandoning: a send that
 * would have succeeded at 12s costs a retry if the budget is 10s.
 */
export const RESEND_TIMEOUT_MS = 20_000

/**
 * PMS provider REST + OAuth calls (Hospitable, OwnerRez, Hostaway).
 *
 * 30s because these are third-party APIs reached from inside Inngest steps
 * that already retry with backoff — a slow-but-alive provider should be given
 * room rather than thrashed, and Inngest handles the eventual failure.
 *
 * These were the four remaining entries in the external-fetch-timeout
 * baseline, and hospitableFetch() is the reason the gap mattered more than the
 * count suggests: it is the single wrapper every Hospitable API call goes
 * through, and hospIncrementalSync runs at concurrency [{limit: 8}]. Eight
 * requests hung on an unresponsive provider therefore consumed the whole
 * concurrency budget and stalled ALL Hospitable webhook processing — the
 * chokepoint that exists so one place needs the timeout was the one place
 * without it.
 *
 * ownerrez-api.ts had this value inline already; it now shares the constant.
 */
export const PMS_API_TIMEOUT_MS = 30_000

/**
 * True when `err` is the abort raised by AbortSignal.timeout() — i.e. we
 * stopped waiting, as opposed to the service returning an error.
 *
 * `AbortSignal.timeout()` rejects with a DOMException named 'TimeoutError'.
 * A caller-supplied AbortController.abort() rejects with 'AbortError'; both
 * are treated as timeouts here since either way no response ever arrived.
 */
export function isTimeoutError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const name = (err as { name?: unknown }).name
  return name === 'TimeoutError' || name === 'AbortError'
}
