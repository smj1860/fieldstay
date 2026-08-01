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
