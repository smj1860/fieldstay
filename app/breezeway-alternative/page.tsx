// ============================================================================
// /breezeway-alternative — comparison landing page.
//
// Target queries: "breezeway alternative", "fieldstay vs breezeway",
// "breezeway pricing" (people hit a paywall on Breezeway's own site past 4
// properties and go looking for a number). The FAQ carries FAQPage structured
// data for the conversational long tail, same pattern as /strops.
//
// EVERY factual claim about either product comes from
// ./comparison-data.ts, which cites the implementing file (for FieldStay) or
// the public source and check date (for Breezeway). Nothing here is
// aspirational or inferred — see that file's header for why, and
// unit/pages/breezeway-alternative.test.ts for what it enforces.
// ============================================================================

import type { Metadata } from 'next'
import Link from 'next/link'

import { COMPARISON_ROWS, FIELDSTAY_HIGHLIGHTS, GUARANTEE_PILLARS, RESEARCHED_ON } from './comparison-data'
import { buildJsonLd, serializeJsonLd, BREEZEWAY_PATH } from './json-ld'
import { BREEZEWAY_FAQ as FAQS } from '@/lib/faq-content'
import { monthlyCostCents } from '@/lib/stripe/brackets'
import { marketingUrl, marketingOrigin, appUrl } from '@/lib/marketing'
import FaqDetailsSection from '@/components/faq/FaqDetailsSection'

const PATH = BREEZEWAY_PATH
const CANONICAL = marketingUrl(PATH)

// Worked example quoted in the hero and the pricing section — computed from
// the real schedule, not typed twice. See lib/stripe/brackets.ts.
const EXAMPLE_QTY = 10
const examplePriceDollars = monthlyCostCents(EXAMPLE_QTY)! / 100

export const metadata: Metadata = {
  title: 'Breezeway Alternative: FieldStay vs Breezeway',
  description:
    'Looking for a Breezeway alternative? FieldStay publishes real pricing to 150 properties ' +
    '(no sales call) and a no-login vendor portal. Free 14-day trial.',
  keywords: [
    'breezeway alternative',
    'fieldstay vs breezeway',
    'breezeway pricing',
    'breezeway competitors',
    'short-term rental operations software comparison',
    'vacation rental property care software alternative',
  ],
  // Absolute apex canonical — fieldstay.app and app.fieldstay.app are aliases
  // of one deployment, so a relative value would resolve against the root
  // layout's metadataBase (NEXT_PUBLIC_APP_URL) and name the wrong one.
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'FieldStay vs Breezeway — pricing and features compared',
    description:
      'Published graduated pricing up to 150 properties, no sales call required. A vendor work order that ' +
      'needs no account and no app. See the full comparison.',
    url: CANONICAL,
    type: 'website',
    images: ['/logo.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FieldStay vs Breezeway',
    description: 'Transparent per-property pricing vs. a custom quote past 4 units. A no-login vendor portal vs. a required app.',
    images: ['/logo.png'],
  },
}

// ── NO AUTH CHECK HERE, ON PURPOSE — see app/strops/page.tsx's header
// comment for the full reasoning (cookies()/getUser() forces dynamic
// rendering and made these pages intermittently unfetchable by Googlebot).
// proxy.ts already redirects an authenticated visitor away from /signup.
export default function BreezewayAlternativePage() {
  const ctaHref = appUrl('/signup?next=/onboarding')

  return (
    <div className="min-h-screen bg-white">
      <script type="application/ld+json">{serializeJsonLd(buildJsonLd(marketingOrigin()))}</script>

      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-ink)] text-white">
        <div className="max-w-5xl mx-auto px-6 py-20 text-center">
          <p className="text-xs font-bold tracking-[0.16em] uppercase text-[var(--mkt-gold)] mb-4">
            FieldStay vs Breezeway
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold mb-5 font-display leading-tight">
            Looking for a Breezeway alternative?
          </h1>
          {/* The direct-answer paragraph — written to be lifted whole by a
              search snippet or an AI answer engine, with no pronoun that
              needs the heading above it for context. */}
          <p className="text-lg text-[var(--mkt-on-dark-softer)] max-w-2xl mx-auto mb-9">
            FieldStay is a short-term rental operations platform, like Breezeway. The two biggest practical
            differences: FieldStay publishes one graduated price for any portfolio size up to 150 properties
            with no sales call, and vendors complete a FieldStay work order from a link on their phone with
            no account and nothing to install.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
            <Link
              href={ctaHref}
              className="px-7 py-3.5 rounded-xl font-bold bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)] transition-colors"
            >
              Start free 14-day trial
            </Link>
            <span className="text-sm text-[var(--mkt-on-dark-soft)]">No credit card required · Starting at $49/month</span>
          </div>
        </div>
      </section>

      {/* ── Comparison table ───────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-2 font-display">
          FieldStay vs Breezeway, side by side
        </h2>
        <p className="text-[var(--mkt-muted)] mb-10 max-w-2xl">
          Every claim below cites where it comes from — see the note at the bottom of this section.
        </p>

        <div className="overflow-x-auto rounded-2xl border border-[var(--mkt-border)]">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[var(--mkt-surface)]">
                <th className="p-4 text-sm font-bold text-[var(--mkt-muted)] uppercase tracking-wide w-1/6">Category</th>
                <th className="p-4 text-sm font-bold text-[var(--mkt-ink)] w-5/12">FieldStay</th>
                <th className="p-4 text-sm font-bold text-[var(--mkt-muted)] w-5/12">Breezeway</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.category} className="border-t border-[var(--mkt-border)] align-top">
                  <td className="p-4 text-sm font-semibold text-[var(--mkt-ink)]">{row.category}</td>
                  <td className="p-4 text-sm text-[var(--mkt-muted-strong)] leading-relaxed">{row.fieldstay}</td>
                  <td className="p-4 text-sm text-[var(--mkt-muted)] leading-relaxed">{row.breezeway}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-[var(--mkt-muted)] mt-4">
          FieldStay claims are verifiable against this product directly. Breezeway information reflects
          Breezeway&apos;s public website and help documentation as checked on {RESEARCHED_ON} — a
          competitor&apos;s pricing and features can change at any time, so verify current details at{' '}
          <a
            href="https://www.breezeway.io/pricing"
            rel="nofollow noopener"
            target="_blank"
            className="underline hover:text-[var(--mkt-ink)]"
          >
            breezeway.io
          </a>{' '}
          before deciding.
        </p>
      </section>

      {/* ── Worked pricing example ─────────────────────────────────────── */}
      <section className="bg-[var(--mkt-surface)] border-y border-[var(--mkt-border)]">
        <div className="max-w-5xl mx-auto px-6 py-16">
          <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-2 font-display">
            A real number, not a sales call
          </h2>
          <p className="text-[var(--mkt-muted)] mb-10 max-w-2xl">
            Here&apos;s what a {EXAMPLE_QTY}-property portfolio actually costs on each platform, today, with
            no demo required to find out.
          </p>
          <div className="grid md:grid-cols-2 gap-8">
            <div className="rounded-2xl border-2 border-[var(--mkt-gold)] bg-white p-8">
              <div className="text-xs font-bold tracking-wide uppercase text-[var(--mkt-gold-hover)] mb-2">FieldStay</div>
              <div className="font-black text-[var(--mkt-ink)] mb-2" style={{ fontSize: 44, letterSpacing: '-0.02em' }}>
                ${examplePriceDollars}<span className="text-lg font-semibold text-[var(--mkt-muted)]">/mo</span>
              </div>
              <p className="text-sm text-[var(--mkt-muted-strong)]">
                For {EXAMPLE_QTY} properties, computed from the published graduated rate schedule — see it for
                your own count with{' '}
                <Link href="/pricing" className="underline hover:text-[var(--mkt-gold-hover)]">
                  the calculator on the pricing page
                </Link>.
              </p>
            </div>
            <div className="rounded-2xl border border-[var(--mkt-border)] bg-white p-8">
              <div className="text-xs font-bold tracking-wide uppercase text-[var(--mkt-muted)] mb-2">Breezeway</div>
              <div className="font-black text-[var(--mkt-muted)] mb-2" style={{ fontSize: 44, letterSpacing: '-0.02em' }}>
                Custom quote
              </div>
              <p className="text-sm text-[var(--mkt-muted)]">
                Breezeway&apos;s published $19.99/property rate only covers portfolios of 4 or fewer. At{' '}
                {EXAMPLE_QTY} properties you&apos;re past that — pricing requires a demo.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── The Glass Box Operations Guarantee ──────────────────────────── */}
      <section className="bg-[var(--mkt-ink)] text-white">
        <div className="max-w-5xl mx-auto px-6 py-16">
          <p className="text-xs font-bold tracking-[0.16em] uppercase text-[var(--mkt-gold)] mb-3 text-center">
            The Glass Box Operations Guarantee
          </p>
          <h2 className="text-3xl font-bold mb-3 font-display text-center">
            Most software asks you to trust it. We&apos;d rather show you.
          </h2>
          <p className="text-[var(--mkt-on-dark-softer)] max-w-2xl mx-auto mb-12 text-center">
            Every action your crew, your vendors, and the software itself take is visible, timestamped, and
            yours to see. That&apos;s not a slogan — it&apos;s a guarantee.
          </p>
          <div className="grid md:grid-cols-3 gap-8">
            {GUARANTEE_PILLARS.map((p) => (
              <div key={p.title}>
                <div className="font-semibold mb-2">{p.title}</div>
                <p className="text-sm text-[var(--mkt-on-dark-soft)] leading-relaxed">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FieldStay-only highlights ───────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-2 font-display">
          Also worth knowing
        </h2>
        <p className="text-[var(--mkt-muted)] mb-10 max-w-2xl">
          Real, shipped FieldStay capabilities — not compared above because we couldn&apos;t independently
          confirm Breezeway&apos;s equivalent one way or the other, and this page only makes claims it can back up.
        </p>
        <div className="grid md:grid-cols-2 gap-8">
          {FIELDSTAY_HIGHLIGHTS.map((h) => (
            <div key={h.title} className="rounded-xl border border-[var(--mkt-border)] p-5">
              <div className="font-semibold text-[var(--mkt-ink)] mb-1.5">{h.title}</div>
              <p className="text-sm text-[var(--mkt-muted)] leading-relaxed">{h.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── FAQ ────────────────────────────────────────────────────────── */}
      <FaqDetailsSection items={FAQS} />

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
