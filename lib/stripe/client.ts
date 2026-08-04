import Stripe from 'stripe'
import { STRIPE_TIMEOUT_MS } from '@/lib/http/timeout'

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
      apiVersion: '2025-02-24.acacia',
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
 * this just stops the type system from claiming a guarantee it never had. The
 * one consumer (createCheckoutSession in app/(dashboard)/settings/actions.ts)
 * already branches on a falsy price id, so nothing downstream changes.
 *
 * Deliberately still evaluated at module load, NOT behind the lazy Proxy
 * above: reading process.env is free and cannot throw, unlike constructing a
 * Stripe client, which is what broke `next build` and put that Proxy there.
 */
function priceId(name: string): string | null {
  const value = process.env[name]
  return value && value.trim().length > 0 ? value : null
}

export const PLANS = {
  starter: {
    name:           'Starter',
    monthlyPriceId: priceId('STRIPE_PRICE_STARTER_MONTHLY'),
    annualPriceId:  priceId('STRIPE_PRICE_STARTER_ANNUAL'),
    maxProperties:  15,
    monthlyPrice:   199,
    annualPrice:    1990,
    description:    'Up to 15 properties',
  },
  growth: {
    name:           'Growth',
    monthlyPriceId: priceId('STRIPE_PRICE_GROWTH_MONTHLY'),
    annualPriceId:  priceId('STRIPE_PRICE_GROWTH_ANNUAL'),
    maxProperties:  50,
    monthlyPrice:   479,
    annualPrice:    4790,
    description:    '16–50 properties',
  },
  portfolio: {
    name:           'Portfolio',
    monthlyPriceId: priceId('STRIPE_PRICE_PORTFOLIO_MONTHLY'),
    annualPriceId:  priceId('STRIPE_PRICE_PORTFOLIO_ANNUAL'),
    maxProperties:  100,
    monthlyPrice:   799,
    annualPrice:    7990,
    description:    '51–100 properties',
  },
  enterprise: {
    name:           'Enterprise',
    monthlyPriceId: null,
    annualPriceId:  null,
    maxProperties:  999,
    monthlyPrice:   null,
    annualPrice:    null,
    description:    '100+ properties — contact for pricing',
  },
} as const

export type PlanKey = keyof typeof PLANS

export function getPlanByPriceId(priceId: string): PlanKey | null {
  for (const [key, plan] of Object.entries(PLANS)) {
    if (
      ('monthlyPriceId' in plan && plan.monthlyPriceId === priceId) ||
      ('annualPriceId'  in plan && plan.annualPriceId  === priceId)
    ) {
      return key as PlanKey
    }
  }
  return null
}
