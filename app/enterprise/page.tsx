// app/enterprise/page.tsx
//
// The segment page for operators at the top of FieldStay's pricing curve —
// Portfolio band (51-150 properties) through true Enterprise (151+, custom
// quote). Structurally mirrors /hosts (dark hero, direct-to-persona copy,
// feature emphasis, FAQ, CTA) for the opposite end of the ICP.
//
// NOT a /hosts-style 2-card pricing layout — that comparison is deliberately
// narrow (Hosts vs. Starter) for a small-portfolio funnel. This page uses
// the full GenericPricingSection/PricingCards grid instead, same as
// /pricing: a large operator benefits from seeing the whole curve and
// landing on the calculator to get their real number at 75, 120, or 200
// properties, which is a more honest CTA than a generic "Contact Sales" for
// anyone who isn't actually above the self-serve ceiling. No forced
// highlight override on the Portfolio card — PricingCards.tsx always
// computes its highlight from the calculator's current value (DEFAULT_QTY
// falls in Growth); adding a per-page override would be a special case for
// one page rather than letting the component behave the way it already does
// everywhere else.
//
// Every claim in the "multi-location," "reporting," and "migration"
// sections below is checked against what's actually built, not aspirational
// — see the inline comments citing the real feature each one describes.

import type { Metadata } from 'next'
import Link from 'next/link'
import GenericPricingSection from '@/components/pricing/GenericPricingSection'
import FaqSection from '@/components/faq/FaqSection'
import { buildJsonLd, serializeJsonLd, FAQ_ITEMS as FAQS, ENTERPRISE_PATH } from './json-ld'
import { marketingUrl, marketingOrigin, appUrl } from '@/lib/marketing'

const PATH = ENTERPRISE_PATH
const CANONICAL = marketingUrl(PATH)

// Same intersection-of-every-page entry features /pricing uses — an
// Enterprise visitor under the self-serve ceiling sees the same Hosts-tier
// card as everyone else at the bottom of the calculator.
const ENTRY_FEATURES = [
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
  // Not "FieldStay Enterprise..." — the root layout's title template already
  // appends " — FieldStay" to every page's own title.
  title: 'Enterprise Property Operations Software',
  description:
    'FieldStay for large STR portfolios and multi-location operations: unlimited properties, SLA-backed ' +
    'uptime, and volume pricing. See published rates or talk to us directly.',
  keywords: [
    'enterprise property management software',
    'multi-portfolio STR operations software',
    'large scale vacation rental software',
    'STR software for property management companies',
  ],
  openGraph: {
    title: 'FieldStay Enterprise',
    description: 'Property operations for large, multi-location STR portfolios.',
    url: CANONICAL,
    type: 'website',
    images: ['/logo.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FieldStay Enterprise',
    description: 'Property operations for large, multi-location STR portfolios.',
    images: ['/logo.png'],
  },
}

// ── NO AUTH CHECK HERE, ON PURPOSE — see app/strops/page.tsx's header
// comment for the full reasoning (cookies()/getUser() forces dynamic
// rendering and made these pages intermittently unfetchable by Googlebot).
// proxy.ts already redirects an authenticated visitor away from /signup.
export default function EnterprisePage() {
  const ctaHref = appUrl('/signup?next=/onboarding')

  return (
    <div className="min-h-screen bg-white">
      <script type="application/ld+json">{serializeJsonLd(buildJsonLd(marketingOrigin()))}</script>

      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-ink)] text-white">
        <div className="max-w-3xl mx-auto px-6 py-20 text-center">
          <p className="text-xs font-bold tracking-[0.16em] uppercase text-[var(--mkt-gold)] mb-4">
            Enterprise
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold mb-5 font-display leading-tight">
            Running 50, 100, or 300 properties shouldn&apos;t mean 50, 100, or 300
            versions of the same spreadsheet.
          </h1>
          <p className="text-lg text-[var(--mkt-on-dark-softer)] max-w-2xl mx-auto mb-9">
            FieldStay scales the same operations engine every property manager uses — turnovers, crew,
            inventory, maintenance, and reporting — up to a full portfolio, with unlimited properties and
            volume pricing once you outgrow the self-serve schedule.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
            <Link
              href={ctaHref}
              className="px-7 py-3.5 rounded-xl font-bold bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)] transition-colors"
            >
              Start free 14-day trial
            </Link>
            <a
              href="mailto:hello@fieldstay.app"
              className="px-7 py-3.5 rounded-xl font-bold border border-white/25 text-white hover:bg-white/10 transition-colors"
            >
              Talk to us
            </a>
          </div>
        </div>
      </section>

      {/* ── Multi-location / multi-team ──────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-4 font-display">
          One operations board, however many cities you&apos;re in.
        </h2>
        <p className="text-[var(--mkt-muted-strong)] leading-relaxed max-w-3xl">
          Every property in your portfolio — whatever state or city it&apos;s in — lives on the same
          turnover board and can be filtered by property or by crew member, so a manager overseeing
          multiple regions can pull up exactly the slice they&apos;re responsible for without leaving
          the app. Crew members only ever see their own assigned turnovers, wherever they&apos;re
          working from.
        </p>
      </section>

      {/* ── Reporting rollups ─────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-surface)] border-y border-[var(--mkt-border)]">
        <div className="max-w-5xl mx-auto px-6 py-16">
          <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-4 font-display">
            One view across every property you manage.
          </h2>
          <p className="text-[var(--mkt-muted-strong)] leading-relaxed max-w-3xl">
            The Ops Snapshot dashboard rolls up today&apos;s unassigned turnovers, open and urgent work
            orders, and low-stock alerts across your entire portfolio — not property by property. It&apos;s
            built for a single organization&apos;s full operation, however many properties that is, not a
            report you have to reassemble from separate views.
          </p>
        </div>
      </section>

      {/* ── Migration ──────────────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-4 font-display">
          What happens to your existing data.
        </h2>
        <p className="text-[var(--mkt-muted-strong)] leading-relaxed max-w-3xl">
          If you&apos;re on OwnerRez, Hospitable, or Hostex, connecting your account pulls in your full
          booking history — not just what&apos;s upcoming — the moment you connect, so nothing before
          today is lost. There&apos;s no separate migration product beyond that sync; it&apos;s the same
          connection every FieldStay account uses, just running at your scale. Portfolio and Enterprise
          accounts get custom onboarding and dedicated account support to walk through the cutover with
          you directly.
        </p>
      </section>

      {/* ── Pricing ────────────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-surface)] border-y border-[var(--mkt-border)]">
        <div className="max-w-5xl mx-auto px-6 py-16">
          <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-2 font-display text-center">
            See your real number, or talk to us about volume pricing.
          </h2>
          <p className="text-[var(--mkt-muted)] text-center mb-10 max-w-2xl mx-auto">
            The calculator covers self-serve pricing up to 150 properties. Above that, or if your
            operation needs a custom deployment, the Enterprise tier is volume-priced per contract.
          </p>
          <GenericPricingSection entryFeatures={ENTRY_FEATURES} signupHref={ctaHref} />
        </div>
      </section>

      {/* ── FAQ ────────────────────────────────────────────────────────── */}
      <FaqSection items={FAQS} />

      {/* ── CTA ────────────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-ink)] text-white">
        <div className="max-w-3xl mx-auto px-6 py-16 text-center">
          <h2 className="text-3xl font-bold mb-4 font-display">
            Talk to us about your portfolio.
          </h2>
          <p className="text-[var(--mkt-on-dark-softer)] mb-8">
            Whether you&apos;re at 60 properties or 600, we can walk through what FieldStay looks like
            at your scale.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
            <a
              href="mailto:hello@fieldstay.app"
              className="inline-block px-8 py-4 rounded-xl font-bold bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)] transition-colors"
            >
              Talk to us
            </a>
            <Link
              href={ctaHref}
              className="inline-block px-8 py-4 rounded-xl font-bold border border-white/25 text-white hover:bg-white/10 transition-colors"
            >
              Start free trial instead
            </Link>
          </div>
          <p className="text-sm text-[var(--mkt-on-dark-soft)] mt-8">
            Not sure which fits?{' '}
            <Link href="/pricing" className="underline hover:text-[var(--mkt-gold)]">See published pricing</Link>
          </p>
        </div>
      </section>
    </div>
  )
}
