import Stripe from 'stripe'

/**
 * Stripe server client — only used server-side.
 * Never import this in Client Components.
 */
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-03-31.basil',
  typescript: true,
})

/**
 * Plan definitions — maps plan names to Stripe price IDs
 * and property limits.
 */
export const PLANS = {
  starter: {
    name: 'Starter',
    priceId: process.env.STRIPE_PRICE_STARTER!,
    maxProperties: 5,
    description: 'Up to 5 properties',
  },
  growth: {
    name: 'Growth',
    priceId: process.env.STRIPE_PRICE_GROWTH!,
    maxProperties: 20,
    description: 'Up to 20 properties',
  },
  pro: {
    name: 'Pro',
    priceId: process.env.STRIPE_PRICE_PRO!,
    maxProperties: 50,
    description: 'Up to 50 properties',
  },
  enterprise: {
    name: 'Enterprise',
    priceId: null,  // custom — contact sales
    maxProperties: 999,
    description: 'Unlimited properties',
  },
} as const

export type PlanKey = keyof typeof PLANS
