import Stripe from 'stripe'

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
    })
  }
  return realClient
}

export const stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver)
  },
})

export const PLANS = {
  starter: {
    name:           'Starter',
    monthlyPriceId: process.env.STRIPE_PRICE_STARTER_MONTHLY!,
    annualPriceId:  process.env.STRIPE_PRICE_STARTER_ANNUAL!,
    maxProperties:  15,
    monthlyPrice:   199,
    annualPrice:    1990,
    description:    'Up to 15 properties',
  },
  growth: {
    name:           'Growth',
    monthlyPriceId: process.env.STRIPE_PRICE_GROWTH_MONTHLY!,
    annualPriceId:  process.env.STRIPE_PRICE_GROWTH_ANNUAL!,
    maxProperties:  50,
    monthlyPrice:   479,
    annualPrice:    4790,
    description:    '16–50 properties',
  },
  portfolio: {
    name:           'Portfolio',
    monthlyPriceId: process.env.STRIPE_PRICE_PORTFOLIO_MONTHLY!,
    annualPriceId:  process.env.STRIPE_PRICE_PORTFOLIO_ANNUAL!,
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
