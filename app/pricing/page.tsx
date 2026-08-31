// app/pricing/page.tsx
//
// The dedicated pricing page. Everything /breezeway-alternative's "see it
// on the pricing page" line and /enterprise's pricing section point at.
//
// Almost entirely composition: GenericPricingSection (which wraps
// PricingCards + plan-tiers.ts, the same numbers every other landing page
// reads from) does the real work. This page supplies only what's genuinely
// page-specific — the hero, metadata, and a generic (non-PMS-specific)
// entry-tier feature list.
//
// Not a PricingSection (components/pricing/PricingSection.tsx) consumer —
// that component is typed to provider: "ownerrez" | "hospitable" and builds
// its CTA from that provider slug, which has no correct value here. See
// components/pricing/GenericPricingSection.tsx's header comment.
//
// Entry-tier features below are generic on purpose — this page has no PMS
// to sell against, unlike /ownerrez or /hospitable's entry bullets.

import type { Metadata } from 'next'
import Link from 'next/link'
import GenericPricingSection from '@/components/pricing/GenericPricingSection'
import { marketingUrl, appUrl } from '@/lib/marketing'

const PATH = '/pricing'
const CANONICAL = marketingUrl(PATH)

// The intersection of what every integration landing page promises — no
// wording naming a specific PMS as the sales hook, since this page has no
// PMS context of its own.
const GENERIC_ENTRY_FEATURES = [
  'iCal sync (Airbnb, VRBO) — or connect OwnerRez/Hospitable',
  'Offline-ready crew app with photo capture',
  'No-login vendor work order portal',
  'Inventory with auto-restock',
  'Maintenance scheduling',
  'Owner P&L portal',
  'RepuGuard reputation management',
] as const

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
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-ink)] text-white">
        <div className="max-w-3xl mx-auto px-6 py-20 text-center">
          <p className="text-xs font-bold tracking-[0.16em] uppercase text-[var(--mkt-gold)] mb-4">
            Pricing
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold mb-5 font-display leading-tight">
            One published rate. No sales call.
          </h1>
          <p className="text-lg text-[var(--mkt-on-dark-softer)] max-w-2xl mx-auto mb-9">
            $49/month for your first property, graduated down to $6/property as your portfolio grows —
            up to 150 properties, self-serve, no quote required. Use the calculator below to see your
            exact number.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
            <Link
              href={ctaHref}
              className="px-7 py-3.5 rounded-xl font-bold bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)] transition-colors"
            >
              Start free 14-day trial
            </Link>
            <span className="text-sm text-[var(--mkt-on-dark-soft)]">No credit card required</span>
          </div>
        </div>
      </section>

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

      {/* ── CTA ────────────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-ink)] text-white">
        <div className="max-w-3xl mx-auto px-6 py-16 text-center">
          <h2 className="text-3xl font-bold mb-4 font-display">
            See your own number, not a sales call.
          </h2>
          <p className="text-[var(--mkt-on-dark-softer)] mb-8">
            Connect your PMS and FieldStay builds your turnover schedule from your existing bookings.
            Fourteen days free, no credit card.
          </p>
          <Link
            href={ctaHref}
            className="inline-block px-8 py-4 rounded-xl font-bold bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)] transition-colors"
          >
            Start free trial
          </Link>
          <p className="text-sm text-[var(--mkt-on-dark-soft)] mt-8">
            Already using OwnerRez or Hospitable?{' '}
            <Link href="/ownerrez" className="underline hover:text-[var(--mkt-gold)]">OwnerRez</Link>
            {' · '}
            <Link href="/hospitable" className="underline hover:text-[var(--mkt-gold)]">Hospitable</Link>
            {' · '}
            <Link href="/strops" className="underline hover:text-[var(--mkt-gold)]">Works with no signal</Link>
          </p>
        </div>
      </section>
    </div>
  )
}
