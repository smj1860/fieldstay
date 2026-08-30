import type { BillingInterval } from '@/lib/stripe/client'

/**
 * The Stripe Checkout idempotency key, in a plain module.
 *
 * Not in actions.ts: that file is `'use server'`, and such a module may export
 * only async functions. A `const` or a sync function there fails the NEXT
 * BUILD — not tsc, not vitest — and the error names a different export from
 * the same file, so it reads as an unrelated action having vanished.
 */

/**
 * How long one Checkout idempotency key stays stable.
 *
 * Sized to the problem the key actually solves. Stripe saves the status code
 * and body of the FIRST request made under a key and replays it for every
 * later request with that key — errors included, for the 24 hours it holds
 * them. So a key with no time component does not merely deduplicate a
 * double-click; it PINS a failure.
 *
 * On 2026-08-28 a checkout failed because STRIPE_PRICE_GROWTH_MONTHLY held a
 * stale id — a price under an older, since-archived Growth product, while a
 * perfectly healthy Growth product sat alongside it in the catalogue.
 * Repointing the variable fixes it, and that button would still have gone on
 * returning the identical error for the rest of the day, replayed from cache
 * and never re-evaluated, with a fresh Sentry report each time that read as
 * "the fix did not work". A billing path that cannot be re-tested for 24 hours
 * after a config fix is worse than one with no idempotency key at all.
 *
 * Ten minutes: a double-click is seconds apart, and even an impatient
 * back-and-re-click after a slow redirect lands inside one bucket. Two clicks
 * straddling a boundary get separate sessions — the pre-existing behaviour for
 * any two clicks more than 24h apart, and caught downstream, since once either
 * checkout completes stripe_customer_id is set and createCheckoutSession's
 * live-subscription guard refuses the second.
 */
export const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000

/**
 * Idempotency key for a Checkout session, stable within one window.
 *
 * No plan component any more — there is only one graduated price per
 * interval (lib/stripe/client.ts PLATFORM_PRICE), so orgId + interval fully
 * identifies which session a double-click would otherwise duplicate. The
 * quantity (property count) at checkout time deliberately does NOT go in the
 * key: two clicks a few seconds apart should collapse to one session even if
 * a property was added in between, and Stripe records whatever quantity the
 * FIRST request actually sent regardless of what a later click would compute.
 *
 * `now` is injectable so a test can assert the rotation over two instants
 * rather than by matching the key string — a test that recomputes the key from
 * the same expression it is checking passes whatever that expression is.
 */
export function checkoutIdempotencyKey(
  orgId: string,
  interval: BillingInterval,
  now: number = Date.now(),
): string {
  const bucket = Math.floor(now / CHECKOUT_IDEMPOTENCY_WINDOW_MS)
  return `checkout:${orgId}:${interval}:${bucket}`
}
