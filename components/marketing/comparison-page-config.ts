import type { Metadata } from 'next'

import type { ComparisonRow } from '@/app/breezeway-alternative/comparison-data'
import { TRIAL_OFFER, FIELDSTAY_HIGHLIGHTS } from '@/app/breezeway-alternative/comparison-data'
import { serializeJsonLd } from '@/app/strops/json-ld'
import type { FaqItem } from '@/lib/faq-content'
import { appUrl, marketingOrigin } from '@/lib/marketing'
import { monthlyCostCents } from '@/lib/stripe/brackets'
import type { ComparisonPageData } from './ComparisonPage'

// ============================================================================
// Everything the "<competitor> alternative" pages have in common, so a page
// file holds only what is actually about that competitor (its name, keywords,
// hero answer, and which data, FAQ and JSON-LD builder to use).
//
// The page files keep the NO-AUTH-CHECK rule from app/strops/page.tsx: nothing
// here reads cookies() or calls auth, because that forces dynamic rendering and
// made these pages intermittently unfetchable by Googlebot.
// ============================================================================

// Worked example quoted in the metadata and the pricing section, computed from
// the real schedule, not typed twice. See lib/stripe/brackets.ts.
export const EXAMPLE_QTY = 10
export const examplePriceDollars = monthlyCostCents(EXAMPLE_QTY)! / 100

// The page files keep their own `title`, `alternates.canonical` and
// `description` keys on purpose: unit/guardrails/marketing-pages-crawlable.test.ts
// reads each page's source to prove it sets an apex canonical and its own
// description, so those three stay literal there and only their values come
// from here.
export const comparisonDescription = (competitor: string) =>
  `Looking for a ${competitor} alternative? FieldStay publishes real pricing up to 150 properties, ` +
  `no sales call: ${EXAMPLE_QTY} properties is $${examplePriceDollars}/mo. Free 14-day trial.`

export const comparisonSocial = (competitor: string, canonical: string): Pick<Metadata, 'openGraph' | 'twitter'> => ({
  openGraph: {
    title: `FieldStay vs ${competitor}: pricing and features compared`,
    description: 'Published graduated pricing up to 150 properties, no sales call required. See the full comparison.',
    url: canonical,
    type: 'website',
    images: ['/logo.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: `FieldStay vs ${competitor}`,
    description: 'Transparent per-property pricing, published to 150 properties.',
    images: ['/logo.png'],
  },
})

export function comparisonPageData(input: Readonly<{
  competitor:           string
  heroAnswer:           string
  rows:                 readonly ComparisonRow[]
  researchedOn:         string
  competitorPricingUrl: string
  competitorPriceCard:  { headline: string; body: string }
  faqs:                 readonly FaqItem[]
  buildJsonLd:          (marketingUrl: string) => object
}>): ComparisonPageData {
  const { competitor, buildJsonLd, ...rest } = input
  return {
    ...rest,
    competitor,
    eyebrow: `FieldStay vs ${competitor}`,
    h1: `Looking for a ${competitor} alternative?`,
    trialOffer: TRIAL_OFFER,
    highlights: FIELDSTAY_HIGHLIGHTS,
    ctaHref: appUrl('/signup?next=/onboarding'),
    jsonLd: serializeJsonLd(buildJsonLd(marketingOrigin())),
    exampleQty: EXAMPLE_QTY,
    examplePriceDollars,
  }
}
