// app/for-vendors/page.tsx
//
// The one page on the site written TO the vendor, not the PM — vendors and
// contractors who already interact with FieldStay through the no-login
// work-order portal via a property manager's account. FieldStay is not the
// thing being sold here: the CTA is "tell your property manager clients
// about FieldStay," not "sign up." Vendors are the referral engine, not the
// buyer.
//
// Every step described in "How it actually works" is checked against the
// live token-portal flow (app/work-orders/[token]/vendor-portal.tsx,
// lib/stripe/vendor-connect-invite.ts, lib/inngest/functions/
// work-order-dispatch.ts and work-order-invoice.ts), not
// docs/support/26-work-order-vendor-dispatch.md, which describes an older
// sign-off-only flow that predates the current itemized invoice + Stripe
// Connect payout system and is stale relative to what's actually live.
//
// "TradeSuite" is referenced below because it's the ALREADY-LIVE branding a
// vendor sees on the real dispatch email and portal ("powered by
// TradeSuite" / "Payment processed via Stripe Connect · FieldStay ·
// TradeSuite") — not a future promise. This page names no unshipped product
// or feature from the separate FieldStay<->TradeSuite integration decided
// 2026-06-13 — that work is not live, and this page makes no claim about it.
//
// No pricing section — vendors don't pay for FieldStay.

import type { Metadata } from 'next'
import Link from 'next/link'
import FaqSection from '@/components/faq/FaqSection'
import { buildJsonLd, serializeJsonLd, FAQ_ITEMS as FAQS, FOR_VENDORS_PATH } from './json-ld'
import { marketingUrl, marketingOrigin } from '@/lib/marketing'

const PATH = FOR_VENDORS_PATH
const CANONICAL = marketingUrl(PATH)

const REFERRAL_SUBJECT = 'Have you looked at FieldStay?'
const REFERRAL_BODY =
  'Hey — I work with you on property maintenance, and the work orders you send through FieldStay ' +
  'are the easiest ones I get: a link, no login, no app, and I get paid straight to my bank once ' +
  'the invoice is approved. If you\'re not already using it for everything, might be worth a look: ' +
  'https://fieldstay.app/for-vendors'
const REFERRAL_MAILTO =
  `mailto:?subject=${encodeURIComponent(REFERRAL_SUBJECT)}&body=${encodeURIComponent(REFERRAL_BODY)}`

export const metadata: Metadata = {
  alternates: { canonical: CANONICAL },
  // Not "FieldStay for Vendors..." — the root layout's title template
  // already appends " — FieldStay" to every page's own title.
  title: 'For Vendors & Contractors — No Login Work Orders',
  description:
    'Get short-term rental work orders and get paid without an app or a login. See how FieldStay works ' +
    'for cleaners, maintenance techs, and vendors — and how to ask your property manager to switch.',
  keywords: [
    'no login work order app',
    'vendor portal short term rental',
    'get paid for cleaning jobs',
    'contractor work order app no account',
  ],
  openGraph: {
    title: 'FieldStay for Vendors',
    description: 'No app. No login. Just the work order and a way to get paid.',
    url: CANONICAL,
    type: 'website',
    images: ['/logo.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FieldStay for Vendors',
    description: 'No app. No login. Just the work order and a way to get paid.',
    images: ['/logo.png'],
  },
}

// ── NO AUTH CHECK HERE, ON PURPOSE — see app/strops/page.tsx's header
// comment for the full reasoning (cookies()/getUser() forces dynamic
// rendering and made these pages intermittently unfetchable by Googlebot).
export default function ForVendorsPage() {
  return (
    <div className="min-h-screen bg-white">
      <script type="application/ld+json">{serializeJsonLd(buildJsonLd(marketingOrigin()))}</script>

      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="bg-[var(--mkt-ink)] text-white">
        <div className="max-w-3xl mx-auto px-6 py-20 text-center">
          <p className="text-xs font-bold tracking-[0.16em] uppercase text-[var(--mkt-gold)] mb-4">
            For Vendors &amp; Contractors
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold mb-5 font-display leading-tight">
            No login. No app. Just the work order and a way to get paid.
          </h1>
          <p className="text-lg text-[var(--mkt-on-dark-softer)] max-w-2xl mx-auto">
            If a property manager you work with uses FieldStay, this is what you can expect from every
            work order they send you.
          </p>
        </div>
      </section>

      {/* ── How it actually works ─────────────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-10 font-display text-center">
          How it actually works
        </h2>
        <div className="space-y-6">
          {[
            {
              num: '01',
              title: 'You get a link',
              body: 'When a property manager assigns you a work order, you get an email with a secure link — property details, scope of work, and the authorized spending limit, all visible before you start.',
            },
            {
              num: '02',
              title: 'You open it — no account',
              body: 'The link works on its own. No password, no app to install, nothing to create. You can submit a quote first if one was requested, or go straight to the job.',
            },
            {
              num: '03',
              title: 'You mark it complete, with photos',
              body: 'When the work is done, add your name and attach photos from your phone directly on that same page.',
            },
            {
              num: '04',
              title: 'You submit your invoice',
              body: 'Before your first payout, you\'ll set up a Stripe Connect account — a one-time step so payment has somewhere to land. After that, submit an itemized invoice for the job.',
            },
            {
              num: '05',
              title: 'You get paid',
              body: 'The property manager reviews and approves your invoice, and payment is sent via Stripe Connect directly to your bank account — the same payment infrastructure most modern platforms use.',
            },
          ].map((step) => (
            <div key={step.num} className="flex gap-5 items-start">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[var(--mkt-ink)] text-[var(--mkt-gold)] flex items-center justify-center text-sm font-bold">
                {step.num}
              </div>
              <div>
                <div className="font-semibold text-[var(--mkt-ink)] mb-1">{step.title}</div>
                <p className="text-sm text-[var(--mkt-muted)] leading-relaxed">{step.body}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-[var(--mkt-muted)] text-center mt-10">
          This work order and payment tooling runs on TradeSuite — the same infrastructure you may
          already recognize from the &ldquo;powered by TradeSuite&rdquo; footer on a FieldStay dispatch email.
        </p>
      </section>

      {/* ── If you're a property manager ─────────────────────────────────── */}
      <section className="bg-[var(--mkt-surface)] border-y border-[var(--mkt-border)]">
        <div className="max-w-3xl mx-auto px-6 py-14 text-center">
          <h2 className="text-xl font-bold text-[var(--mkt-ink)] mb-3 font-display">
            Are you the property manager, not the vendor?
          </h2>
          <p className="text-[var(--mkt-muted-strong)] mb-6">
            This page is written for the vendors and contractors your work orders go to. If you&apos;re
            evaluating FieldStay for your own operation, start here instead.
          </p>
          <Link
            href="/"
            className="inline-block px-6 py-3 rounded-xl font-bold bg-[var(--mkt-ink)] text-white hover:bg-[var(--mkt-ink-hover)] transition-colors"
          >
            See FieldStay for property managers
          </Link>
        </div>
      </section>

      {/* ── Referral CTA ─────────────────────────────────────────────────── */}
      <section className="max-w-3xl mx-auto px-6 py-16 text-center">
        <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-4 font-display">
          Not all of your property managers use FieldStay yet?
        </h2>
        <p className="text-[var(--mkt-muted-strong)] mb-8 max-w-xl mx-auto">
          If you&apos;d rather every work order worked this way, send them this page.
        </p>
        <a
          href={REFERRAL_MAILTO}
          className="inline-block px-8 py-4 rounded-xl font-bold bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)] transition-colors"
        >
          Email your property manager about FieldStay
        </a>
        <p className="text-xs text-[var(--mkt-muted)] mt-4 max-w-md mx-auto">
          Opens your email app with a message already written — edit it however you like before sending.
        </p>
      </section>

      {/* ── FAQ ────────────────────────────────────────────────────────── */}
      <FaqSection items={FAQS} />
    </div>
  )
}
