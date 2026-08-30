// ============================================================================
// /strops — the SEO landing page for offline capability.
//
// Target: people searching for a turnover/cleaning app that works where there
// is no cell service. Head terms are "offline turnover app", "cleaning app
// without internet", "STR app no cell service"; the money query is the
// conversational long tail — "what app is best for turnovers in low service
// areas" — which is why the FAQ questions are phrased as searches and carry
// FAQPage structured data.
//
// Slug is keyword-bearing rather than a bare /offline for two reasons: it
// matches the query in the SERP, and /offline would sit confusingly next to
// public/offline.html, the service worker's own fallback page.
//
// EVERY capability claim comes from ./offline-capabilities.ts, which cites the
// implementing file for each one. Nothing on this page is aspirational — see
// that file's header.
// ============================================================================

import type { Metadata } from 'next'
import Link from 'next/link'

import {
  LOADS_OFFLINE,
  READ_OFFLINE,
  WRITE_OFFLINE,
  RELIABILITY,
  NEEDS_CONNECTION,
  type Capability,
} from './offline-capabilities'
import { STROPS_FAQ as FAQS } from '@/lib/faq-content'
import { buildJsonLd, serializeJsonLd, STROPS_PATH } from './json-ld'
import { marketingUrl, marketingOrigin, appUrl } from '@/lib/marketing'

const PATH = STROPS_PATH
const CANONICAL = marketingUrl(PATH)

export const metadata: Metadata = {
  // Under 60 chars so it does not truncate in the SERP, leading with the
  // phrase people actually type.
  title: 'Offline Turnover App for No-Service Properties',
  description:
    'FieldStay works with no cell service. Cleaners open checklists, take photos and complete turnovers ' +
    'offline; everything syncs when signal returns. Built for rural and dead-zone rentals.',
  keywords: [
    'offline turnover app',
    'cleaning app that works without internet',
    'STR app no cell service',
    'vacation rental cleaning app offline',
    'turnover app low service area',
    'property management app rural no signal',
    'offline checklist app for cleaners',
  ],
  // ABSOLUTE, not relative. The root layout's metadataBase is
  // NEXT_PUBLIC_APP_URL, so a relative '/strops' would resolve to
  // app.fieldstay.app/strops — the wrong host. Both hostnames are aliases of
  // one deployment, so this tag is what tells Google which of the two
  // identical URLs is the real one.
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'The turnover app that works with no signal',
    description:
      'Checklists, photos and turnover completion all work offline. Everything syncs itself when the ' +
      'phone finds a bar. Built for cabins, lake houses and anywhere the cell map lies.',
    url: CANONICAL,
    type: 'website',
    images: ['/logo.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'The turnover app that works with no signal',
    description: 'Offline-first crew app for rural and dead-zone short-term rentals.',
    images: ['/logo.png'],
  },
}

function CapabilityList({ items }: Readonly<{ items: Capability[] }>) {
  return (
    <ul className="space-y-4">
      {items.map((c) => (
        <li key={c.title} className="flex gap-3">
          <svg
            width="16" height="14" viewBox="0 0 12 10" fill="none"
            className="flex-shrink-0 mt-1.5" aria-hidden="true"
          >
            <path
              d="M1 5l4 4 6-8" stroke="var(--mkt-gold)" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
          <div>
            <div className="font-semibold text-[var(--mkt-ink)]">{c.title}</div>
            <p className="text-sm text-[var(--mkt-muted)] mt-0.5">{c.body}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}

// ── NO AUTH CHECK HERE, ON PURPOSE ──────────────────────────────────────────
//
// This page used to call cookies() + supabase.auth.getUser() to decide whether
// the CTA said "Sign up" or "Go to dashboard". That cost far more than it was
// worth:
//
//   * cookies() forces DYNAMIC rendering — no static generation, no CDN cache,
//     a cold server render on every single request including every crawl.
//   * getUser() is a network round trip to Supabase Auth, with no timeout, on
//     a page whose entire purpose is to be fetched by strangers.
//   * For a crawler the answer is ALWAYS "no user" — a guaranteed-useless call
//     that made the page uncacheable and unreliable.
//
// Measured against production 2026-08-19: these pages intermittently failed to
// respond at all (connection hang to timeout, /hosts 3 of 8 requests), while
// example.com / google.com / vercel.com were 12 of 12 clean. Google reported
// all seven marketing and legal URLs as "Discovered - currently not indexed"
// with "Last crawled: N/A" — the signature of Google throttling a host it
// cannot reliably fetch.
//
// The branch was also REDUNDANT. proxy.ts already redirects an authenticated
// visitor away from /login and /signup to /ops
// (redirectAuthenticatedAwayFromPublic), so a logged-in reader who clicks the
// logged-out CTA still lands in the app. The only thing lost is a nav label
// reading "Log In" instead of "Dashboard" for a logged-in visitor on an
// acquisition page — which is not who these pages are for.
//
// proxy.ts already made this argument at the middleware layer, under the
// heading "ANONYMOUS TRAFFIC PAYS NOTHING". The page components were doing the
// work anyway.
export default function OfflineTurnoverAppPage() {
  // Absolute against the APP origin, not relative. Supabase sets host-only
  // auth cookies (no `domain` in lib/supabase/server.ts), so signing up at
  // fieldstay.app/signup would create a session the app at app.fieldstay.app
  // never sees — the visitor would arrive logged out.
  const ctaHref = appUrl('/signup?next=/onboarding')

  return (
    <div className="min-h-screen bg-white">
      {/* Structured data. Rendered from the same FAQS array the page below
          renders, so the rich result can never describe copy that is not
          actually on the page. See serializeJsonLd() for why this is a text child. */}
      <script type="application/ld+json">{serializeJsonLd(buildJsonLd(marketingOrigin()))}</script>

      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-ink)] text-white">
        <div className="max-w-5xl mx-auto px-6 py-20 text-center">
          <p className="text-xs font-bold tracking-[0.16em] uppercase text-[var(--mkt-gold)] mb-4">
            Built for dead zones
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold mb-5 font-display leading-tight">
            The turnover app that works
            <br className="hidden sm:block" /> with no signal.
          </h1>
          <p className="text-lg text-[var(--mkt-on-dark-softer)] max-w-2xl mx-auto mb-4">
            Your cleaner is standing in the basement of a lake house with no bars. In most apps
            that is where the workflow stops. In FieldStay it is a normal Tuesday.
          </p>
          <p className="text-base text-[var(--mkt-on-dark-soft)] max-w-2xl mx-auto mb-9">
            Checklists, photos, inventory counts and turnover completion all work offline.
            Everything syncs itself the moment the phone finds a bar — no sync button, nothing lost.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
            <Link
              href={ctaHref}
              className="px-7 py-3.5 rounded-xl font-bold bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)] transition-colors"
            >
              Start free 14-day trial
            </Link>
            {/* The JSON-LD SoftwareApplication.offers block below already
                cites $49 as this product's starting price -- that claim
                needs to be visible on the page itself, not only in markup a
                crawler reads. See json-ld.ts and unit/pages/strops.test.ts
                for the two places that depend on "$49" appearing here
                verbatim. */}
            <span className="text-sm text-[var(--mkt-on-dark-soft)]">No credit card required · Starting at $49/month</span>
          </div>
        </div>
      </section>

      {/* ── The core claim ─────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <div className="rounded-2xl border border-[var(--mkt-border)] bg-[var(--mkt-surface)] p-8">
          <h2 className="text-2xl font-bold text-[var(--mkt-ink)] mb-3 font-display">
            {LOADS_OFFLINE.title}
          </h2>
          <p className="text-[var(--mkt-muted-strong)] leading-relaxed">{LOADS_OFFLINE.body}</p>
        </div>
      </section>

      {/* ── What works offline ─────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 pb-16">
        <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-2 font-display">
          What your crew can do with zero bars
        </h2>
        <p className="text-[var(--mkt-muted)] mb-10">
          Not a read-only cache. The full job, start to finish, on a phone in airplane mode.
        </p>

        <div className="grid md:grid-cols-2 gap-10">
          <div>
            <h3 className="text-sm font-bold tracking-[0.12em] uppercase text-[var(--mkt-muted)] mb-5">
              Available on the device
            </h3>
            <CapabilityList items={READ_OFFLINE} />
          </div>
          <div>
            <h3 className="text-sm font-bold tracking-[0.12em] uppercase text-[var(--mkt-muted)] mb-5">
              Things they can actually do
            </h3>
            <CapabilityList items={WRITE_OFFLINE} />
          </div>
        </div>
      </section>

      {/* ── Reliability ────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-surface)] border-y border-[var(--mkt-border)]">
        <div className="max-w-5xl mx-auto px-6 py-16">
          <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-2 font-display">
            Caching data is easy. Not losing it is the hard part.
          </h2>
          <p className="text-[var(--mkt-muted)] mb-10 max-w-2xl">
            Plenty of apps store data on the phone. The question that matters is what happens to a
            change made in a basement when the app gets killed, the battery dies, or the upload
            fails. Three guarantees:
          </p>
          <div className="grid md:grid-cols-3 gap-8">
            {RELIABILITY.map((r) => (
              <div key={r.title}>
                <div className="font-semibold text-[var(--mkt-ink)] mb-2">{r.title}</div>
                <p className="text-sm text-[var(--mkt-muted)] leading-relaxed">{r.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Honest limits ──────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-2 font-display">
          What still needs a connection
        </h2>
        <p className="text-[var(--mkt-muted)] mb-8 max-w-2xl">
          You would find these in a day of trialling, so here they are now.
        </p>
        <div className="grid md:grid-cols-3 gap-8">
          {NEEDS_CONNECTION.map((n) => (
            <div
              key={n.title}
              className="rounded-xl border border-[var(--mkt-border)] p-5"
            >
              <div className="font-semibold text-[var(--mkt-ink)] mb-1.5">{n.title}</div>
              <p className="text-sm text-[var(--mkt-muted)] leading-relaxed">{n.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── FAQ ────────────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-surface)] border-t border-[var(--mkt-border)]">
        <div className="max-w-3xl mx-auto px-6 py-16">
          <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-10 font-display text-center">
            Questions people actually ask
          </h2>
          <div className="space-y-4">
            {FAQS.map((f) => (
              <details
                key={f.question}
                className="group rounded-xl border border-[var(--mkt-border)] bg-white p-5"
              >
                <summary className="font-semibold text-[var(--mkt-ink)] cursor-pointer list-none flex justify-between items-center gap-4">
                  {f.question}
                  <span
                    aria-hidden="true"
                    className="text-[var(--mkt-gold)] text-xl leading-none group-open:rotate-45 transition-transform"
                  >
                    +
                  </span>
                </summary>
                <p className="text-sm text-[var(--mkt-muted-strong)] leading-relaxed mt-3">
                  {f.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ────────────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-ink)] text-white">
        <div className="max-w-3xl mx-auto px-6 py-16 text-center">
          <h2 className="text-3xl font-bold mb-4 font-display">
            Try it somewhere with no signal.
          </h2>
          <p className="text-[var(--mkt-on-dark-softer)] mb-8">
            Genuinely — that is the test. Install it, put the phone in airplane mode, and run a
            turnover. Fourteen days free, no credit card.
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
          </p>
        </div>
      </section>
    </div>
  )
}
