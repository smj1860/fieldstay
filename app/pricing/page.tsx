// app/pricing/page.tsx
//
// The dedicated pricing page. Everything /breezeway-alternative's "see it
// on the pricing page" line and /enterprise's pricing section point at.
//
// Almost entirely composition: GenericPricingSection (which wraps
// PricingCards + plan-tiers.ts, the same numbers every other landing page
// reads from) does the real work. This page supplies only what's genuinely
// page-specific — the hero and metadata.
//
// Not a PricingSection (components/pricing/PricingSection.tsx) consumer —
// that component is typed to provider: "ownerrez" | "hospitable" and builds
// its CTA from that provider slug, which has no correct value here. See
// components/pricing/GenericPricingSection.tsx's header comment.
//
// Entry-tier features come from plan-tiers.ts's GENERIC_ENTRY_FEATURES, not
// a local array — this page and /enterprise both have no PMS to sell
// against, unlike /ownerrez or /hospitable's entry bullets, and a local copy
// in each was byte-identical: SonarCloud flagged it as duplication on new
// code (2026-08-31).
//
// Hero and closing CTA band use components/marketing/MarketingHero.tsx and
// MarketingCtaBand.tsx, shared with /enterprise — the two pages' hero/CTA
// markup started as independent copies of the same shape and SonarCloud
// flagged 43%/17% duplication between them the same day.

import type { Metadata } from 'next'
import Link from 'next/link'
import GenericPricingSection from '@/components/pricing/GenericPricingSection'
import { GENERIC_ENTRY_FEATURES } from '@/components/pricing/plan-tiers'
import MarketingHero from '@/components/marketing/MarketingHero'
import MarketingCtaBand from '@/components/marketing/MarketingCtaBand'
import { marketingUrl, appUrl } from '@/lib/marketing'

const PATH = '/pricing'
const CANONICAL = marketingUrl(PATH)

export const metadata: Metadata = {
  alternates: { canonical: CANONICAL },
  title: 'Pricing — Published Rates, No Sales Call',
  description:
    'FieldStay pricing: $49/mo for your first property, graduated down to $6/property up to 150 units. ' +
    'See your exact number with the calculator. 14-day free trial, no credit card required.',
  keywords: [
    'fieldstay pricing',
    'property management software pricing',
    'STR operations software cost',
    'short term rental software pricing',
  ],
  openGraph: {
    title: 'FieldStay Pricing',
    description: 'Published, graduated pricing up to 150 properties. No sales call required to see your number.',
    url: CANONICAL,
    type: 'website',
    images: ['/logo.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FieldStay Pricing',
    description: 'Published, graduated pricing up to 150 properties. No sales call required.',
    images: ['/logo.png'],
  },
}

// ── NO AUTH CHECK HERE, ON PURPOSE — see app/strops/page.tsx's header
// comment for the full reasoning (cookies()/getUser() forces dynamic
// rendering and made these pages intermittently unfetchable by Googlebot).
// proxy.ts already redirects an authenticated visitor away from /signup.
export default function PricingPage() {
  const ctaHref = appUrl('/signup?next=/onboarding')

  return (
    <div className="min-h-screen bg-white">
      <MarketingHero
        eyebrow="Pricing"
        title="One published rate. No sales call."
        subtitle={
          <>
            $49/month for your first property, graduated down to $6/property as your portfolio grows —
            up to 150 properties, self-serve, no quote required. Use the calculator below to see your
            exact number.
          </>
        }
      >
        <Link
          href={ctaHref}
          className="px-7 py-3.5 rounded-xl font-bold bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)] transition-colors"
        >
          Start free 14-day trial
        </Link>
        <span className="text-sm text-[var(--mkt-on-dark-soft)]">No credit card required</span>
      </MarketingHero>

      {/* ── Pricing calculator + cards ─────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <GenericPricingSection entryFeatures={GENERIC_ENTRY_FEATURES} signupHref={ctaHref} />
        <p className="text-center text-sm text-[var(--mkt-muted)] mt-4">
          Managing more than 150 properties?{' '}
          <a href="mailto:hello@fieldstay.app" className="underline hover:text-[var(--mkt-ink)]">
            Talk to us about Enterprise
          </a>
          , or see{' '}
          <Link href="/enterprise" className="underline hover:text-[var(--mkt-ink)]">
            what&apos;s built for large portfolios
          </Link>
          .
        </p>
      </section>

      <MarketingCtaBand
        title="See your own number, not a sales call."
        subtitle="Connect your PMS and FieldStay builds your turnover schedule from your existing bookings. Fourteen days free, no credit card."
        footer={
          <>
            Already using OwnerRez or Hospitable?{' '}
            <Link href="/ownerrez" className="underline hover:text-[var(--mkt-gold)]">OwnerRez</Link>
            {' · '}
            <Link href="/hospitable" className="underline hover:text-[var(--mkt-gold)]">Hospitable</Link>
            {' · '}
            <Link href="/strops" className="underline hover:text-[var(--mkt-gold)]">Works with no signal</Link>
          </>
        }
      >
        <Link
          href={ctaHref}
          className="inline-block px-8 py-4 rounded-xl font-bold bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)] transition-colors"
        >
          Start free trial
        </Link>
      </MarketingCtaBand>
    </div>
  )
}
