import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
  typescript: true,
})

export const PLANS = {
  pro: {
    name:           'Pro',
    monthlyPriceId: process.env.STRIPE_PRICE_PRO_MONTHLY!,
    annualPriceId:  process.env.STRIPE_PRICE_PRO_ANNUAL!,
    maxProperties:  15,
    monthlyPrice:   149,
    annualPrice:    1490,
    description:    'Up to 15 properties',
  },
  growth: {
    name:           'Growth',
    monthlyPriceId: process.env.STRIPE_PRICE_GROWTH_MONTHLY!,
    annualPriceId:  process.env.STRIPE_PRICE_GROWTH_ANNUAL!,
    maxProperties:  45,
    monthlyPrice:   219,
    annualPrice:    2190,
    description:    '16–45 properties',
  },
  enterprise: {
    name:           'Enterprise',
    monthlyPriceId: null,
    annualPriceId:  null,
    maxProperties:  999,
    monthlyPrice:   null,
    annualPrice:    null,
    description:    '45+ properties — contact for pricing',
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
