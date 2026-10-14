// ============================================================================
// Shared renderer for the "<competitor> alternative" landing pages.
//
// Same section sequence and markup as app/breezeway-alternative/page.tsx
// (hero, comparison table + disclaimer, worked pricing example, trial offer,
// FieldStay-only highlights, FAQ, CTA). Only the competitor-specific strings
// are data; see each app/<slug>/comparison-data.ts for the citation rules
// every one of those strings must meet.
//
// The page that renders this owns metadata, the JSON-LD payload and the
// NO-AUTH-CHECK rule (see app/strops/page.tsx's header comment). This
// component is a Server Component with no hooks and no cookies() read.
// ============================================================================

import Link from 'next/link'

import FaqDetailsSection from '@/components/faq/FaqDetailsSection'
import type { FaqItem } from '@/lib/faq-content'
import type { ComparisonRow, TrialOffer } from '@/app/breezeway-alternative/comparison-data'

export interface ComparisonPageData {
  /** Display name, e.g. 'Turno'. Used in headings and the table header. */
  competitor:           string
  /** Eyebrow over the H1, e.g. 'FieldStay vs Turno'. */
  eyebrow:              string
  h1:                   string
  /** Direct-answer paragraph under the H1. No pronoun that needs the H1 for context. */
  heroAnswer:           string
  rows:                 readonly ComparisonRow[]
  /** Oldest check date across rows. Rendered as "checked on or after". */
  researchedOn:         string
  /** Competitor's public pricing URL for the disclaimer link. */
  competitorPricingUrl: string
  /** Worked example, competitor side. Either a published figure or a "no public number" explanation. */
  competitorPriceCard:  { headline: string; body: string }
  trialOffer:           TrialOffer
  highlights:           ReadonlyArray<{ title: string; body: string; source: string }>
  faqs:                 readonly FaqItem[]
  ctaHref:              string
  jsonLd:               string   // already serialized
  exampleQty:           number
  examplePriceDollars:  number
}

type SectionProps = Readonly<{ data: ComparisonPageData }>

function Hero({ data }: SectionProps) {
  return (
    <section className="bg-[var(--mkt-ink)] text-white">
      <div className="max-w-5xl mx-auto px-6 py-20 text-center">
        <p className="text-xs font-bold tracking-[0.16em] uppercase text-[var(--mkt-gold)] mb-4">
          {data.eyebrow}
        </p>
        <h1 className="text-4xl sm:text-5xl font-bold mb-5 font-display leading-tight">{data.h1}</h1>
        {/* The direct-answer paragraph: written to be lifted whole by a search
            snippet or an AI answer engine, with no pronoun that needs the
            heading above it for context. */}
        <p className="text-lg text-[var(--mkt-on-dark-softer)] max-w-2xl mx-auto mb-9">{data.heroAnswer}</p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
          <Link
            href={data.ctaHref}
            className="px-7 py-3.5 rounded-xl font-bold bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)] transition-colors"
          >
            Start free 14-day trial
          </Link>
          <span className="text-sm text-[var(--mkt-on-dark-soft)]">No credit card required · Starting at $19/month</span>
        </div>
      </div>
    </section>
  )
}

// ComparisonRow keeps the field names `breezeway` / `breezewaySource` because
// the Breezeway page and its test read them. Here they mean "the competitor
// column". Renaming them to `competitor` belongs to the later migration of
// the Breezeway page onto this component.
function ComparisonTable({ data }: SectionProps) {
  return (
    <section className="max-w-5xl mx-auto px-6 py-16">
      <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-2 font-display">
        FieldStay vs {data.competitor}, side by side
      </h2>
      <p className="text-[var(--mkt-muted)] mb-10 max-w-2xl">
        Every claim below cites where it comes from. See the note at the bottom of this section.
      </p>

      <div className="overflow-x-auto rounded-2xl border border-[var(--mkt-border)]">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-[var(--mkt-surface)]">
              <th className="p-4 text-sm font-bold text-[var(--mkt-muted)] uppercase tracking-wide w-1/6">Category</th>
              <th className="p-4 text-sm font-bold text-[var(--mkt-ink)] w-5/12">FieldStay</th>
              <th className="p-4 text-sm font-bold text-[var(--mkt-muted)] w-5/12">{data.competitor}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
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
        FieldStay claims are verifiable against this product directly. {data.competitor} information reflects{' '}
        {data.competitor}&apos;s public website and help documentation, checked on or after {data.researchedOn}.
        Rows are re-checked one at a time, so some carry a later date than others. A
        competitor&apos;s pricing and features can change at any time, so verify current details on{' '}
        <a
          href={data.competitorPricingUrl}
          rel="nofollow noopener"
          target="_blank"
          className="underline hover:text-[var(--mkt-ink)]"
        >
          {data.competitor}&apos;s website
        </a>{' '}
        before deciding.
      </p>
    </section>
  )
}

function WorkedPricing({ data }: SectionProps) {
  return (
    <section className="bg-[var(--mkt-surface)] border-y border-[var(--mkt-border)]">
      <div className="max-w-5xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-2 font-display">
          A real number, not a sales call
        </h2>
        <p className="text-[var(--mkt-muted)] mb-10 max-w-2xl">
          Here&apos;s what a {data.exampleQty}-property portfolio costs on FieldStay today, with
          no demo required to find out.
        </p>
        <div className="grid md:grid-cols-2 gap-8">
          <div className="rounded-2xl border-2 border-[var(--mkt-gold)] bg-white p-8">
            <div className="text-xs font-bold tracking-wide uppercase text-[var(--mkt-gold-hover)] mb-2">FieldStay</div>
            <div className="font-black text-[var(--mkt-ink)] mb-2" style={{ fontSize: 44, letterSpacing: '-0.02em' }}>
              ${data.examplePriceDollars}<span className="text-lg font-semibold text-[var(--mkt-muted)]">/mo</span>
            </div>
            <p className="text-sm text-[var(--mkt-muted-strong)]">
              For {data.exampleQty} properties, computed from the published graduated rate schedule. See it for
              your own count with{' '}
              <Link href="/pricing" className="underline hover:text-[var(--mkt-gold-hover)]">
                the calculator on the pricing page
              </Link>.
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--mkt-border)] bg-white p-8">
            <div className="text-xs font-bold tracking-wide uppercase text-[var(--mkt-muted)] mb-2">{data.competitor}</div>
            <div className="font-black text-[var(--mkt-muted)] mb-2" style={{ fontSize: 44, letterSpacing: '-0.02em' }}>
              {data.competitorPriceCard.headline}
            </div>
            <p className="text-sm text-[var(--mkt-muted)]">{data.competitorPriceCard.body}</p>
          </div>
        </div>
      </div>
    </section>
  )
}

function TrialBand({ data }: SectionProps) {
  return (
    <section className="bg-[var(--mkt-ink)] text-white">
      <div className="max-w-3xl mx-auto px-6 py-16 text-center">
        <p className="text-xs font-bold tracking-[0.16em] uppercase text-[var(--mkt-gold)] mb-3">
          Try it risk-free
        </p>
        <h2 className="text-2xl font-bold mb-3 font-display">{data.trialOffer.title}</h2>
        <p className="text-[var(--mkt-on-dark-softer)]">{data.trialOffer.body}</p>
      </div>
    </section>
  )
}

function Highlights({ data }: SectionProps) {
  return (
    <section className="max-w-5xl mx-auto px-6 py-16">
      <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-2 font-display">Also worth knowing</h2>
      <p className="text-[var(--mkt-muted)] mb-10 max-w-2xl">
        Real, shipped FieldStay capabilities, not compared above because we couldn&apos;t independently
        confirm {data.competitor}&apos;s equivalent one way or the other, and this page only makes claims it can back up.
      </p>
      <div className="grid md:grid-cols-2 gap-8">
        {data.highlights.map((h) => (
          <div key={h.title} className="rounded-xl border border-[var(--mkt-border)] p-5">
            <div className="font-semibold text-[var(--mkt-ink)] mb-1.5">{h.title}</div>
            <p className="text-sm text-[var(--mkt-muted)] leading-relaxed">{h.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function ClosingCta({ data }: SectionProps) {
  return (
    <section className="bg-[var(--mkt-ink)] text-white">
      <div className="max-w-3xl mx-auto px-6 py-16 text-center">
        <h2 className="text-3xl font-bold mb-4 font-display">See your own number, not a sales call.</h2>
        <p className="text-[var(--mkt-on-dark-softer)] mb-8">
          Connect your PMS and FieldStay builds your turnover schedule from your existing bookings.
          Fourteen days free, no credit card.
        </p>
        <Link
          href={data.ctaHref}
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
  )
}

export default function ComparisonPage({ data }: SectionProps) {
  return (
    <div className="min-h-screen bg-white">
      <script type="application/ld+json">{data.jsonLd}</script>
      <Hero data={data} />
      <ComparisonTable data={data} />
      <WorkedPricing data={data} />
      <TrialBand data={data} />
      <Highlights data={data} />
      <FaqDetailsSection items={data.faqs} />
      <ClosingCta data={data} />
    </div>
  )
}
