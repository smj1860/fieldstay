// app/ownerrez/page.tsx  —  full replacement

import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import Link from 'next/link'
import type { Metadata } from 'next'
import RepuGuardWrapper from '@/components/repuguard/RepuGuardWrapper'
import PricingSection from '@/components/ownerrez/PricingSection'
import FaqSection from '@/components/ownerrez/faq-section'

export const metadata: Metadata = {
  title: 'FieldStay for OwnerRez',
  description: 'Connect your OwnerRez account for automated turnovers, crew management, inventory, and maintenance — free 14-day trial, no credit card required.',
  openGraph: {
    title: 'FieldStay for OwnerRez',
    description: 'The operations layer your OwnerRez account is missing.',
    images: ['/logo.png'],
  },
}

export default async function OwnerRezPage() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } }
  )

  const { data: { user } } = await supabase.auth.getUser()
  const isLoggedIn = !!user

  return (
    <div className="min-h-screen">

      {/* ══════════════════════════════════════════
          SECTION 1 — DARK NAVY
          Nav · Badge · Hero
      ══════════════════════════════════════════ */}
      <div className="bg-brand-800 text-white">
        <div className="max-w-6xl mx-auto px-6">

          {/* Nav */}
          <nav className="flex items-center justify-between py-5">
            <span className="text-xl font-bold">
              <span className="text-white">Field</span>
              <span className="text-gold-300">Stay</span>
            </span>
            {isLoggedIn ? (
              <Link href="/dashboard" className="text-sm text-white/58 hover:text-white transition-colors">
                Dashboard
              </Link>
            ) : (
              <Link
                href="/login?next=/api/integrations/ownerrez/connect"
                className="text-sm text-white/58 hover:text-white transition-colors"
              >
                Log In
              </Link>
            )}
          </nav>

          {/* OwnerRez Partner Badge */}
          <div className="flex justify-center mt-6 mb-10">
            <div className="flex items-center gap-2 bg-brand-panel border border-brand-panelBorder rounded-full px-4 py-2">
              <span
                className="text-white text-xs font-bold px-2 py-0.5 rounded"
                style={{ background: '#3D8B4F' }}
              >
                OR
              </span>
              <span className="text-xs font-semibold tracking-widest text-white/58 uppercase">
                OwnerRez Integration Partner
              </span>
            </div>
          </div>

          {/* Hero — two equal columns */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-start pb-20">

            {/* Left — copy */}
            <div>
              <h1 className="text-4xl lg:text-5xl font-bold leading-tight mb-6 font-display">
                The operations layer your{' '}
                <span className="text-gold-300">OwnerRez account</span>{' '}
                is missing.
              </h1>
              <p className="text-white/52 text-lg leading-relaxed mb-8">
                FieldStay connects directly to your OwnerRez bookings to automate
                everything your team handles on the ground — offline-ready turnover
                management, crew checklists, asset inventory with par-level alerts,
                field maintenance scheduling, and built-in reputation management.
              </p>
              <div className="flex flex-wrap gap-5">
                {[
                  'Free 14-day trial',
                  'No credit card required',
                  'Connects in minutes',
                ].map(item => (
                  <div key={item} className="flex items-center gap-2">
                    <div className="w-5 h-5 bg-gold-300 rounded-full flex items-center justify-center flex-shrink-0">
                      <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                        <path
                          d="M1 4l3 3 5-6"
                          stroke="#0a1628"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    <span className="text-sm font-medium text-white/65">{item}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Right — What syncs automatically (trust panel).
                Deliberately not a RepuGuard panel — see Task 4 note in
                CLAUDE_LANDING_ANGLE_A_1.md. RepuGuard's own demo section
                lives further down this page, untouched. */}
            <div className="bg-brand-panel border border-brand-panelBorder rounded-2xl p-8">

              <div className="flex items-center justify-between mb-5">
                <h2 className="text-2xl font-bold text-white leading-snug">
                  What happens the moment you connect
                </h2>
              </div>

              <div className="space-y-4 mb-6">
                {[
                  {
                    label: 'Properties & Bookings',
                    body: 'Sync in immediately, with real-time updates via webhook as bookings change.',
                  },
                  {
                    label: 'Guest Details',
                    body: 'Guest name and contact info sync automatically the moment a booking is created or updated — no manual entry per stay.',
                  },
                  {
                    label: 'Turnovers',
                    body: 'Generated automatically between consecutive bookings, with crew assignments and offline-ready checklists.',
                  },
                ].map(row => (
                  <div key={row.label} className="flex items-start gap-3">
                    <div className="w-5 h-5 bg-gold-300 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                      <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                        <path
                          d="M1 4l3 3 5-6"
                          stroke="#0a1628"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    <p className="text-sm text-white/65 leading-snug">
                      <span className="text-white font-semibold">{row.label}</span>
                      {' — '}{row.body}
                    </p>
                  </div>
                ))}
              </div>

              {/* Trust callout — reworded to match the real mechanism: RepuGuard
                  never calls the OwnerRez API to post a response. It drafts the
                  reply and links straight to the review on OwnerRez; you submit
                  it yourself. Do not restore "posts when you approve" language —
                  that implies an automated write-back that doesn't exist. */}
              <div className="flex items-center gap-3 bg-brand-800 border border-brand-panelBorder rounded-xl px-4 py-3">
                <span className="w-5 h-5 bg-gold-300 rounded-full flex items-center justify-center flex-shrink-0">
                  <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                    <path d="M1 4l3 3 5-6" stroke="#0a1628" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <p className="text-sm text-white/52">
                  <span className="text-white font-semibold">You post it, on your terms.</span>
                  {' '}FieldStay drafts the response and links you straight to
                  your OwnerRez review — nothing goes out until you submit it
                  yourself.
                </p>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 2 — WHITE
          Pricing
          NOTE: Update PricingSection component separately with new
          price IDs: Starter $199, Growth $479, Portfolio $799.
          RepuGuard should appear as a checkmark in ALL tier feature
          lists — not as an add-on line item.
      ══════════════════════════════════════════ */}
      <div className="bg-white">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <PricingSection isLoggedIn={isLoggedIn} />
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 3 — DARK NAVY
          RepuGuard Live Demo
          Reframed: "see what's built in" not "try before you buy"
      ══════════════════════════════════════════ */}
      <div className="bg-brand-800 text-white">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="text-center mb-10">
            {/* Section label */}
            <div className="inline-flex items-center gap-2 mb-4">
              <div className="bg-gold-300 text-[#0a1628] text-xs font-bold px-2.5 py-1 rounded-md tracking-wider">
                REPUGUARD
              </div>
              <span className="text-white/46 text-sm">Included with every plan</span>
            </div>
            <h2 className="text-3xl font-bold mb-3 font-display">
              See RepuGuard in Action
            </h2>
            <p className="text-white/46 text-lg max-w-xl mx-auto">
              Choose a review scenario below and watch your built-in reputation
              engine generate a response in real time.
            </p>
          </div>
          <RepuGuardWrapper />
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 4 — WHITE
          Features — now 4 cards, RepuGuard as 04
      ══════════════════════════════════════════ */}
      <div className="bg-white">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <h2 className="text-3xl font-bold mb-2 text-center text-[#0a1628] font-display">
            Everything OwnerRez doesn&apos;t handle.
          </h2>
          <p className="text-gray-500 text-center mb-12">
            Built specifically for the field operations side of short-term rentals.
          </p>

          {/* 2×2 grid to accommodate 4 features cleanly */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[
              {
                num: '01',
                title: 'Automated Turnover Management',
                body: 'Bookings from OwnerRez automatically generate turnovers with crew assignments and offline-ready checklists. No manual scheduling — the moment a booking lands, the turnover is queued.',
              },
              {
                num: '02',
                title: 'No-Login Vendor Portal & Work Order Invoicing',
                body: 'Dispatch a work order and your vendor gets a link — no login, no app to install. They submit their line-item invoice from their phone, you approve it with one click, and payment goes straight to their bank.',
              },
              {
                num: '03',
                title: 'Asset Health Scores & CapEx Forecasting',
                body: 'Every water heater, HVAC unit, and appliance gets a health score that updates daily based on age and expected lifespan. FieldStay rolls those scores into a 10-year capital plan automatically.',
              },
              {
                num: '04',
                title: 'Inventory & Maintenance',
                body: 'Set par levels for every property. Low-stock alerts trigger purchase orders automatically. Schedule recurring maintenance — seasonal or routine — with vendor assignments built in.',
              },
              {
                num: '05',
                title: 'Owner Reporting Portal',
                body: 'Property owners get a secure, tokenized P&L portal showing revenue, expenses, and net returns by period. You share one link. They check it themselves.',
              },
              {
                num: '06',
                title: 'RepuGuard — Reputation Management',
                body: 'AI-generated review responses tuned to each guest\'s tone and context. Urgency scoring surfaces overdue responses before they cost you your rating. Included in every FieldStay plan — no add-on, no extra cost.',
                // Visual distinction: highlight this card subtly as a headline feature
                highlight: true,
              },
            ].map(f => (
              <div
                key={f.num}
                className={
                  f.highlight
                    ? 'bg-brand-panel border border-brand-panelBorder rounded-2xl p-6'
                    : 'bg-[#f8fafc] border border-[#e2e8f0] rounded-2xl p-6'
                }
              >
                <div
                  className={`text-xs font-bold mb-3 inline-block px-2 py-0.5 rounded ${
                    f.highlight
                      ? 'bg-gold-300 text-[#0a1628]'
                      : 'bg-brand-800 text-gold-300'
                  }`}
                >
                  {f.num}
                </div>
                <h3
                  className={`font-bold text-lg mb-3 ${
                    f.highlight ? 'text-white' : 'text-[#0a1628]'
                  }`}
                >
                  {f.title}
                </h3>
                <p
                  className={`text-sm leading-relaxed ${
                    f.highlight ? 'text-white/52' : 'text-gray-500'
                  }`}
                >
                  {f.body}
                </p>
                {f.highlight && (
                  <div className="mt-4 flex items-center gap-2">
                    <span className="w-4 h-4 bg-gold-300 rounded-full flex items-center justify-center flex-shrink-0">
                      <svg width="8" height="6" viewBox="0 0 10 8" fill="none">
                        <path d="M1 4l3 3 5-6" stroke="#0a1628" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span className="text-xs text-white/46">Included in every plan · no add-on</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 4b — FAQ
      ══════════════════════════════════════════ */}
      <FaqSection />

      {/* ══════════════════════════════════════════
          SECTION 5 — YELLOW
          CTA
      ══════════════════════════════════════════ */}
      <div className="bg-gold-300">
        <div className="max-w-6xl mx-auto px-6 py-20 text-center">
          <h2 className="text-3xl font-bold mb-3 text-[#0a1628] font-display">
            See your first turnover automate itself today.
          </h2>
          <p className="text-[#0a1628]/70 text-lg mb-10">
            Connect your OwnerRez account and watch FieldStay generate the
            turnover, assign the crew, and queue the checklist automatically.
            Cancel with one click if it doesn&apos;t save your team real time
            in the first week.
          </p>

          {isLoggedIn ? (
            <div className="flex flex-col items-center gap-3">
              {/* Plain <a>, not <Link> — this route 302s straight to OwnerRez's
                  OAuth authorize URL. Link prefetches visible hrefs via
                  fetch() on mount, which follows the redirect into a
                  connect-src CSP violation and crashes the page on load. */}
              <a
                href="/api/integrations/ownerrez/connect"
                className="inline-block bg-brand-800 text-white font-bold px-10 py-4 rounded-xl hover:bg-[#162a4a] transition-colors text-lg"
              >
                Connect OwnerRez →
              </a>
              <p className="text-sm text-[#0a1628]/60">
                You&apos;re already signed in. One click to connect.
              </p>
            </div>
          ) : (
            <div className="max-w-sm mx-auto">
              <Link
                href="/signup?provider=ownerrez&next=/api/integrations/ownerrez/connect"
                className="block w-full bg-brand-800 text-white font-bold px-8 py-4 rounded-xl hover:bg-[#162a4a] transition-colors text-lg text-center mb-4"
              >
                Create your FieldStay account
              </Link>
              <p className="text-sm text-[#0a1628]/60">
                Already have an account?{' '}
                <Link
                  href="/login"
                  className="text-[#0a1628] font-semibold underline hover:no-underline transition-all"
                >
                  Log in
                </Link>
              </p>
            </div>
          )}

          <p className="mt-10 text-sm text-[#0a1628]/50">
            Questions?{' '}
            <a
              href="mailto:hello@fieldstay.app"
              className="text-[#0a1628]/70 hover:text-[#0a1628] transition-colors"
            >
              hello@fieldstay.app
            </a>
          </p>
        </div>
      </div>

    </div>
  )
}