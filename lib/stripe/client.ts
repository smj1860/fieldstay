import Stripe from 'stripe'
import { STRIPE_TIMEOUT_MS } from '@/lib/http/timeout'

/**
 * Pinned Stripe API version. Exported so a report about an unexpected payload
 * shape can name it — the most likely cause of one is a bump to this line.
 */
export const STRIPE_API_VERSION = '2025-02-24.acacia' as const

// Stripe's constructor throws ("Neither apiKey nor config.authenticator
// provided") on an empty string, not just a missing one — so eagerly
// constructing this at module load crashed `next build` outright in any
// environment without STRIPE_SECRET_KEY set, since this file is imported
// by 11+ routes/Inngest functions that Next.js's page-data-collection pass
// loads regardless of whether Stripe is ever actually called. A lazy Proxy
// keeps every existing `stripe.subscriptions.cancel(...)`-style call site
// unchanged — the real client is only constructed on first actual use.
let realClient: Stripe | null = null

function getClient(): Stripe {
  if (!realClient) {
    realClient = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
      apiVersion: STRIPE_API_VERSION,
      typescript: true,
      // The SDK default is 80s, longer than the platform's function budget. A
      // slow call inside the webhook handler (onInvoicePaymentFailed and
      // onInvoicePaymentSucceeded both retrieve a subscription mid-request)
      // gets the whole invocation killed, which skips the catch that releases
      // the dedup claim — and Stripe's retry then hits the still-held claim
      // and is discarded as a duplicate. A bounded timeout turns that into a
      // normal handler throw, which DOES release the claim.
      timeout:           STRIPE_TIMEOUT_MS,
      maxNetworkRetries: 2,
    })
  }
  return realClient
}

export const stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver)
  },
})

/**
 * Price ids were previously read as `process.env.STRIPE_PRICE_*!`. The `!` was
 * a lie: a missing variable produced `undefined` typed as `string`, which then
 * travelled all the way into a Stripe API call and came back as an opaque
 * "No such price" at checkout — a config failure disguised as a payment bug
 * (pre-launch audit 2026-07-30, "No boot-time env validation").
 *
 * These now read honestly as `string | null`. The real prevention is
 * lib/env.ts, which fails the boot on a production deploy missing any of them;
 * this just stops the type system from claiming a guarantee it never had.
 *
 * Deliberately still evaluated at module load, NOT behind the lazy Proxy
 * above: reading process.env is free and cannot throw, unlike constructing a
 * Stripe client, which is what broke `next build` and put that Proxy there.
 */
function priceId(name: string): string | null {
  const value = process.env[name]
  return value && value.trim().length > 0 ? value : null
}

/**
 * The single graduated self-serve price, one per billing interval —
 * replaced the old 4-tier PLANS map (Hosts/Starter/Growth/Portfolio, 8 price
 * ids) on 2026-08-29. Every self-serve org from 1 to
 * MAX_SELF_SERVE_PROPERTIES properties is on ONE of these two Stripe Price
 * objects (billing_scheme: 'tiered', tiers_mode: 'graduated'); what they pay
 * is a function of property-count QUANTITY, not which price they bought. See
 * lib/stripe/brackets.ts for the bracket schedule and the reasoning — that
 * module is what removed the cliff a customer used to hit crossing an old
 * flat-tier boundary.
 *
 * Enterprise stays entirely outside this: contact-sales, a manually
 * negotiated contract, no Stripe price id here — unchanged from before.
 */
export const PLATFORM_PRICE = {
  monthlyPriceId: priceId('STRIPE_PRICE_PLATFORM_MONTHLY'),
  annualPriceId:  priceId('STRIPE_PRICE_PLATFORM_ANNUAL'),
} as const

export type BillingInterval = 'monthly' | 'annual'

export function platformPriceId(interval: BillingInterval): string | null {
  return interval === 'annual' ? PLATFORM_PRICE.annualPriceId : PLATFORM_PRICE.monthlyPriceId
}

/** Is this Stripe price id our graduated self-serve platform price, either interval? */
export function isPlatformPriceId(id: string): boolean {
  return (PLATFORM_PRICE.monthlyPriceId !== null && id === PLATFORM_PRICE.monthlyPriceId)
      || (PLATFORM_PRICE.annualPriceId  !== null && id === PLATFORM_PRICE.annualPriceId)
}

export { MAX_SELF_SERVE_PROPERTIES } from './brackets'
