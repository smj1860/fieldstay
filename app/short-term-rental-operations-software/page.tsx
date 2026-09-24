// ============================================================================
// /short-term-rental-operations-software — the CATEGORY landing page.
//
// ── Why this slug, and why it does not cannibalise the homepage ─────────────
//
// The existing landing pages each own a narrow intent: /strops offline,
// /ownerrez + /hospitable integrations, /hosts the solo operator,
// /breezeway-alternative the competitor comparison, /pricing the number. The
// homepage owns the BRAND query.
//
// What none of them targets is the category query itself — someone who has
// decided they need software for turnovers and crews but does not yet know
// what that category is called or who is in it. That visitor types "short-term
// rental operations software", and increasingly does not type it into Google
// at all; they ask an assistant. The slug is keyword-bearing for the same
// reason /strops's is (its header makes the argument): it matches the query in
// the SERP.
//
// "Operations" is the load-bearing word, not filler. OwnerRez, Hospitable and
// Hostaway are "short-term rental management software"; FieldStay is the layer
// beside them. A slug claiming the broader term would compete with the
// homepage AND misdescribe the product to the exact audience it is for.
//
// ── Written to be QUOTED, not only ranked ──────────────────────────────────
//
// An answer engine extracts a few sentences and shows them to someone who
// never sees this page. Three consequences shape the copy below, and each one
// is a real constraint rather than a flourish:
//
//   1. The DEFINITION section is the first content section, is phrased as the
//      question a model is answering, and answers it in one self-contained
//      sentence naming the subject ("FieldStay is ...", never "we"). It is the
//      same string as the SoftwareApplication description in json-ld.ts —
//      capabilities.ts's DEFINITION — so the prose and the markup cannot drift.
//   2. The BOUNDARIES section says what this is NOT. Models are asked "is X a
//      booking platform" far more than "what does X do", and an explicit
//      boundary is what stops one guessing wrong on our behalf. /strops makes
//      the same argument for its offline limits.
//   3. Every number is on the page in words as well as in a table, because an
//      extraction takes prose and leaves the table behind.
//
// ── No auth call, deliberately ─────────────────────────────────────────────
//
// No cookies(), no auth.getUser(). One such call forces dynamic rendering and
// costs this page static generation, CDN caching and the nonce-free CSP that
// prerendering depends on. app/strops/page.tsx carries the full argument and
// unit/guardrails/marketing-pages-crawlable.test.ts enforces it.
//
// ── Claims ─────────────────────────────────────────────────────────────────
//
// Every capability claim comes from ./capabilities.ts, which cites the
// implementing file or table for each one, and every price from
// components/pricing (which computes from lib/stripe/brackets.ts). Nothing is
// typed as a literal here. The design this page was ported from quoted the
// RETIRED flat four-tier schedule; see capabilities.ts's header.
// ============================================================================

import type { Metadata } from 'next'
import Link from 'next/link'

import {
  BOUNDARIES,
  DEFINITION,
  PILLARS,
  SELF_SERVE_CEILING,
  TURNOVER_STEPS,
  type Capability,
} from './capabilities'
import { buildJsonLd, serializeJsonLd, STR_OPS_FAQ_ITEMS, STR_OPS_PATH } from './json-ld'
import { marketingUrl, marketingOrigin, appUrl } from '@/lib/marketing'
import GenericPricingSection from '@/components/pricing/GenericPricingSection'
import { GENERIC_ENTRY_FEATURES } from '@/components/pricing/plan-tiers'
import FaqDetailsSection from '@/components/faq/FaqDetailsSection'

const PATH = STR_OPS_PATH
const CANONICAL = marketingUrl(PATH)

export const metadata: Metadata = {
  // 50 characters. The root layout's template appends " — FieldStay", taking
  // the rendered title to 62 — marginally past the ~60 the SERP truncates at,
  // which is deliberate: the category phrase is what a searcher scans for and
  // it sits entirely in front, so the brand is the half that gets clipped.
  // Do NOT spell the suffix out here; this page is a child segment of
  // app/layout.tsx and would render it twice (see the crawlability guardrail).
  title: 'Short-Term Rental Operations Software for Managers',
  description:
    'FieldStay is short-term rental operations software: automated turnovers, crew dispatch by proximity, ' +
    'photo-verified inspections, maintenance and inventory. Connects to OwnerRez, Hospitable and Hostaway. ' +
    'From $19/month, 1–150 properties.',
  keywords: [
    'short-term rental operations software',
    'STR operations software',
    'vacation rental operations platform',
    'short term rental turnover software',
    'property management operations software for STR',
    'vacation rental cleaning and maintenance software',
    'STR crew scheduling software',
    'short-term rental property management software',
    'airbnb turnover management software',
  ],
  // ABSOLUTE and apex-hosted. metadataBase is NEXT_PUBLIC_APP_URL, so a
  // relative value would name app.fieldstay.app — the duplicate — as the
  // original. See lib/marketing.ts.
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Short-Term Rental Operations Software',
    description:
      'The layer that runs turnovers, crews, maintenance and inventory after the booking. Connects to the ' +
      'PMS you already use.',
    url: CANONICAL,
    type: 'website',
    images: ['/logo.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Short-Term Rental Operations Software',
    description: 'Automated turnovers, crew dispatch, asset tracking. From $19/month.',
    images: ['/logo.png'],
  },
}

function CapabilityList({ items }: Readonly<{ items: Capability[] }>) {
  return (
    <ul className="space-y-5">
      {items.map((c) => (
        <li key={c.title}>
          <div className="font-semibold text-[var(--mkt-ink)]">{c.title}</div>
          <p className="text-sm text-[var(--mkt-muted)] mt-1 leading-relaxed">{c.body}</p>
        </li>
      ))}
    </ul>
  )
}

export default function StrOperationsSoftwarePage() {
  // Absolute against the APP origin. Supabase sets host-only auth cookies, so
  // a relative /signup would create the session on the marketing host and land
  // the visitor logged OUT on the app. See lib/marketing.ts.
  const ctaHref = appUrl('/signup?next=/onboarding')

  return (
    <div className="min-h-screen bg-white">
      {/* Rendered from the same arrays the page below renders — see
          json-ld.ts. A text child, not dangerouslySetInnerHTML. */}
      <script type="application/ld+json">{serializeJsonLd(buildJsonLd(marketingOrigin()))}</script>

      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-ink)] text-white">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="grid lg:grid-cols-[1.15fr_0.85fr] gap-14 items-center">
            <div>
              <p className="text-xs font-bold tracking-[0.16em] uppercase text-[var(--mkt-gold)] mb-4">
                Short-term rental operations software
              </p>
              <h1 className="text-4xl sm:text-5xl font-bold mb-6 font-display leading-[1.08]">
                <span className="block text-[var(--mkt-on-dark-softer)] text-3xl sm:text-4xl">
                  Operations automated.
                </span>
                <span className="block">Assets protected.</span>
                <span className="block text-[var(--mkt-gold)]">Software paid for.</span>
              </h1>
              <p className="text-lg text-[var(--mkt-on-dark-softer)] max-w-xl mb-8">
                FieldStay routes your crew, verifies every clean, tracks every asset — and turns your
                guest guidebook into local sponsor revenue that credits straight back to your bill.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
                <Link
                  href={ctaHref}
                  className="px-7 py-3.5 rounded-xl font-bold bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)] transition-colors"
                >
                  Start free 14-day trial
                </Link>
                {/* The JSON-LD offers node cites $19 — Google suppresses
                    structured data describing content a visitor cannot see,
                    so the number has to appear here too. Pinned by
                    unit/pages/str-operations-software.test.ts against
                    lib/stripe/brackets.ts. */}
                <span className="text-sm text-[var(--mkt-on-dark-soft)]">
                  No credit card required · Starting at $19/month
                </span>
              </div>
            </div>

            {/* A worked example of the assignment step, not a screenshot —
                static rather than animated so it costs no client JS and
                renders identically for a crawler. */}
            <div
              className="rounded-2xl border border-white/10 bg-white/[0.04] p-6"
              aria-label="Example of automatic job assignment"
            >
              <div className="flex justify-between items-baseline pb-4 mb-4 border-b border-white/10">
                <span className="text-xs font-semibold text-[var(--mkt-on-dark-soft)] uppercase tracking-wider">
                  Today&apos;s queue
                </span>
                <span className="text-xs text-[var(--mkt-gold)] font-semibold">Live</span>
              </div>

              <div className="rounded-xl border border-white/10 bg-[var(--mkt-ink)] p-4 mb-3">
                <div className="font-semibold mb-1">Villa 14 — Turnover clean</div>
                <div className="text-sm text-[var(--mkt-on-dark-soft)] mb-3">
                  Checkout 11:00a · Next check-in 4:00p
                </div>
                <span className="inline-block text-xs font-bold px-2.5 py-1 rounded-full bg-[var(--mkt-gold)]/15 text-[var(--mkt-gold)]">
                  Assigned — Marcus R. · 0.6mi away
                </span>
              </div>

              <div className="rounded-xl border border-white/10 bg-[var(--mkt-ink)] p-4">
                <div className="font-semibold mb-1">Unit 22 — HVAC filter swap</div>
                <div className="text-sm text-[var(--mkt-on-dark-soft)] mb-3">
                  Scheduled maintenance · Due this week
                </div>
                <span className="inline-block text-xs font-bold px-2.5 py-1 rounded-full bg-white/10 text-white/80">
                  Completed &amp; synced to owner portal
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Proof strip ────────────────────────────────────────────────── */}
      <div className="border-b border-[var(--mkt-border)] bg-[var(--mkt-surface)]">
        <div className="max-w-6xl mx-auto px-6 py-6 flex flex-wrap gap-x-10 gap-y-3 justify-between text-sm text-[var(--mkt-muted-strong)]">
          <span>
            Built for portfolios of{' '}
            <b className="text-[var(--mkt-ink)]">1–{SELF_SERVE_CEILING} properties</b>
          </span>
          <span>Works offline in the field — no signal required</span>
          <span>
            Live with <b className="text-[var(--mkt-ink)]">OwnerRez</b>,{' '}
            <b className="text-[var(--mkt-ink)]">Hospitable</b> &amp;{' '}
            <b className="text-[var(--mkt-ink)]">Hostaway</b>
          </span>
          <span>Every plan gets every feature</span>
        </div>
      </div>

      {/* ── The definition ─────────────────────────────────────────────── */}
      {/* FIRST content section on purpose. See this file's header: this is the
          block written to be extracted whole by an answer engine, and
          DEFINITION is the same string json-ld.ts marks up. */}
      <section className="max-w-3xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-5 font-display">
          What is short-term rental operations software?
        </h2>
        <p className="text-lg text-[var(--mkt-muted-strong)] leading-relaxed mb-5">{DEFINITION}</p>
        <p className="text-[var(--mkt-muted)] leading-relaxed">
          The distinction matters when you are comparing tools. A property management system owns the
          booking: listings, calendars, rates, guest messaging, payments. An operations platform owns
          what the booking then requires on the ground — who is cleaning which unit, whether the clean
          was verified, when the water heater is due for replacement, which vendor is certified to take
          the job, and what the owner sees at the end of the month. They meet at exactly one point, the
          reservation, which is why you connect them rather than choose between them.
        </p>
      </section>

      {/* ── Three pillars ──────────────────────────────────────────────── */}
      <section className="border-t border-[var(--mkt-border)]">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-3 font-display">
            One platform, three jobs.
          </h2>
          <p className="text-[var(--mkt-muted)] mb-12 max-w-2xl">
            Each clause of the tagline is a set of tools already running in FieldStay, not a roadmap
            item. Every claim below is traceable to the code that implements it.
          </p>

          <div className="grid lg:grid-cols-3 gap-10">
            {PILLARS.map((p) => (
              <div key={p.tag} className="lg:border-r lg:border-[var(--mkt-border)] lg:pr-8 last:border-r-0 last:pr-0">
                <span className="inline-block text-xs font-bold uppercase tracking-wider text-[var(--mkt-gold)] bg-[var(--mkt-ink)] px-2.5 py-1 rounded mb-5">
                  {p.tag}
                </span>
                <h3 className="text-xl font-bold text-[var(--mkt-ink)] mb-3">{p.heading}</h3>
                <p className="text-sm text-[var(--mkt-muted-strong)] leading-relaxed mb-7">{p.claim}</p>
                <CapabilityList items={p.items} />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How a turnover works — the HowTo node's visible half ────────── */}
      <section className="bg-[var(--mkt-ink)] text-white">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <h2 className="text-3xl font-bold mb-3 font-display">
            How an automated turnover actually works
          </h2>
          <p className="text-[var(--mkt-on-dark-softer)] mb-12 max-w-2xl">
            Four steps. Every one of them happens without anybody opening the app to start it.
          </p>

          <ol className="grid md:grid-cols-4 gap-8">
            {TURNOVER_STEPS.map((s, i) => (
              <li
                key={s.name}
                className="md:border-r md:border-white/10 md:pr-6 last:border-r-0 last:pr-0"
              >
                <span className="block text-sm font-bold text-[var(--mkt-gold)] mb-3">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="font-bold mb-2">{s.name}</h3>
                <p className="text-sm text-[var(--mkt-on-dark-softer)] leading-relaxed">{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Boundaries ─────────────────────────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-3 font-display">
          What FieldStay is not
        </h2>
        <p className="text-[var(--mkt-muted)] mb-10 max-w-2xl">
          You would find these in a day of trialling, so here they are now. Knowing where a tool stops
          is most of knowing whether it fits.
        </p>
        <div className="grid sm:grid-cols-2 gap-6">
          {BOUNDARIES.map((b) => (
            <div key={b.q} className="rounded-xl border border-[var(--mkt-border)] p-5">
              <div className="font-semibold text-[var(--mkt-ink)] mb-2">{b.q}</div>
              <p className="text-sm text-[var(--mkt-muted)] leading-relaxed">{b.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Integrations ───────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-surface)] border-y border-[var(--mkt-border)]">
        <div className="max-w-4xl mx-auto px-6 py-16">
          <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-3 font-display">
            Connects to the PMS you already run
          </h2>
          <p className="text-[var(--mkt-muted)] mb-8 max-w-2xl">
            Reservations and property data sync in — no double entry. No PMS at all? A plain iCal feed
            from Airbnb or VRBO is enough to get your turnover schedule building itself.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/ownerrez"
              className="px-5 py-3 rounded-lg border border-[var(--mkt-border)] bg-white font-semibold text-[var(--mkt-ink)] hover:border-[var(--mkt-gold)] transition-colors"
            >
              OwnerRez
            </Link>
            <Link
              href="/hospitable"
              className="px-5 py-3 rounded-lg border border-[var(--mkt-border)] bg-white font-semibold text-[var(--mkt-ink)] hover:border-[var(--mkt-gold)] transition-colors"
            >
              Hospitable
            </Link>
            <span className="px-5 py-3 rounded-lg border border-[var(--mkt-border)] bg-white font-semibold text-[var(--mkt-ink)]">
              Hostaway
            </span>
            <span className="px-5 py-3 rounded-lg border border-[var(--mkt-border)] bg-white font-semibold text-[var(--mkt-ink)]">
              iCal (Airbnb, VRBO)
            </span>
          </div>
        </div>
      </section>

      {/* ── Pricing ────────────────────────────────────────────────────── */}
      {/* GenericPricingSection computes every figure from
          lib/stripe/brackets.ts via plan-tiers.ts and carries the
          monthly/annual toggle and the per-property calculator. Rendering it
          here rather than restating numbers is what keeps this page from
          becoming the fifth place a price is typed by hand. */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <GenericPricingSection entryFeatures={GENERIC_ENTRY_FEATURES} signupHref={ctaHref} />
        <p className="text-center text-sm text-[var(--mkt-muted)] mt-10 max-w-2xl mx-auto">
          Pricing is graduated, so only the property that crosses a bracket is re-rated — adding your
          fifth property adds that property&apos;s rate, not a new tier&apos;s. Full schedule on the{' '}
          <Link href="/pricing" className="underline hover:text-[var(--mkt-ink)]">
            pricing page
          </Link>
          . Above {SELF_SERVE_CEILING} properties, see{' '}
          <Link href="/enterprise" className="underline hover:text-[var(--mkt-ink)]">
            Enterprise
          </Link>
          .
        </p>
      </section>

      {/* ── FAQ ────────────────────────────────────────────────────────── */}
      {/* The SAME array json-ld.ts marks up as FAQPage — a rich result must
          never describe a question absent from the page. */}
      <FaqDetailsSection
        items={STR_OPS_FAQ_ITEMS.map((f) => ({ question: f.q, answer: f.a }))}
        heading="Short-term rental operations software: common questions"
      />

      {/* ── CTA ────────────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-ink)] text-white">
        <div className="max-w-3xl mx-auto px-6 py-16 text-center">
          <h2 className="text-3xl font-bold mb-4 font-display">
            Automate the operations. Protect the assets.{' '}
            <span className="text-[var(--mkt-gold)]">Let it pay for itself.</span>
          </h2>
          <p className="text-[var(--mkt-on-dark-softer)] mb-8">
            Setup takes a property list and a PMS connection. Your crew can be running jobs offline by
            this week. Fourteen days free, no credit card.
          </p>
          <Link
            href={ctaHref}
            className="inline-block px-8 py-4 rounded-xl font-bold bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)] transition-colors"
          >
            Start free trial
          </Link>
          <p className="text-sm text-[var(--mkt-on-dark-soft)] mt-8">
            Already on a PMS?{' '}
            <Link href="/ownerrez" className="underline hover:text-[var(--mkt-gold)]">OwnerRez</Link>
            {' · '}
            <Link href="/hospitable" className="underline hover:text-[var(--mkt-gold)]">Hospitable</Link>
            {' · '}
            <Link href="/strops" className="underline hover:text-[var(--mkt-gold)]">Offline crew app</Link>
            {' · '}
            <Link href="/breezeway-alternative" className="underline hover:text-[var(--mkt-gold)]">vs Breezeway</Link>
          </p>
        </div>
      </section>
    </div>
  )
}
