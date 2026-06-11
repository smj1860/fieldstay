import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2025-02-24.acacia',
  typescript: true,
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
    monthlyPrice:   379,
    annualPrice:    3790,
    description:    '16–50 properties',
  },
  portfolio: {
    name:           'Portfolio',
    monthlyPriceId: process.env.STRIPE_PRICE_PORTFOLIO_MONTHLY!,
    annualPriceId:  process.env.STRIPE_PRICE_PORTFOLIO_ANNUAL!,
    maxProperties:  100,
    monthlyPrice:   599,
    annualPrice:    5990,
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
