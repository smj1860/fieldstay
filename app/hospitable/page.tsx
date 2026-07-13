// app/hospitable/page.tsx  —  new file
//
// Mirrors the structure of app/ownerrez/page.tsx (dark hero → pricing →
// live demo → feature grid → FAQ → gold CTA) but is NOT a find-and-replace
// copy. Two deliberate differences from the OwnerRez page, both addressed
// in the CRO audit this shipped alongside:
//
//   1. The hero's right-column panel is a "what syncs automatically" trust
//      panel instead of a RepuGuard panel. RepuGuard already gets a full
//      dedicated demo section further down — giving it the entire hero
//      fold too, on a page whose #1 job is answering "what does this do
//      with my Hospitable data," under-sells the sync mechanics that are
//      this integration's actual first objection.
//   2. The feature grid leads with the no-login vendor portal / work order
//      → invoice flow and asset health + CapEx forecasting — two shipped
//      FieldStay features that are not yet represented on the homepage or
//      the OwnerRez page. Recommend backporting both once copy is approved.

import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import Link from 'next/link'
import type { Metadata } from 'next'
import RepuGuardWrapper from '@/components/repuguard/RepuGuardWrapper'
import PricingSection from '@/components/hospitable/PricingSection'
import FaqSection from '@/components/hospitable/faq-section'

export const metadata: Metadata = {
  title: 'FieldStay for Hospitable',
  description: 'Connect your Hospitable account for automated turnovers, crew sync, asset health tracking, and a no-login vendor portal — free 14-day trial, no credit card required.',
  openGraph: {
    title: 'FieldStay for Hospitable',
    description: 'Hospitable runs your guest experience. FieldStay runs everything after they hit Book.',
    images: ['/logo.png'],
  },
}

export default async function HospitablePage() {
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
                href="/login?next=/api/integrations/hospitable/connect"
                className="text-sm text-white/58 hover:text-white transition-colors"
              >
                Log In
              </Link>
            )}
          </nav>

          {/* Hospitable Partner Badge */}
          <div className="flex justify-center mt-6 mb-10">
            <div className="flex items-center gap-2 bg-brand-panel border border-brand-panelBorder rounded-full px-4 py-2">
              <span
                className="text-white text-xs font-bold px-2 py-0.5 rounded"
                style={{ background: '#0F766E' }}
              >
                HB
              </span>
              <span className="text-xs font-semibold tracking-widest text-white/58 uppercase">
                Hospitable Integration Partner
              </span>
            </div>
          </div>

          {/* Hero — two equal columns */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-start pb-20">

            {/* Left — copy */}
            <div>
              <h1 className="text-4xl lg:text-5xl font-bold leading-tight mb-6 font-display">
                Hospitable runs your guest experience.{' '}
                <span className="text-gold-300">FieldStay runs everything after they hit Book.</span>
              </h1>
              <p className="text-white/52 text-lg leading-relaxed mb-8">
                Connect your Hospitable account and every property, booking, and
                teammate syncs in automatically — then FieldStay takes over the
                ground operations Hospitable was never built for: offline-ready
                turnovers, crew checklists, asset health tracking, capital
                planning, and a vendor portal your contractors can use without
                ever creating a login.
              </p>
              <div className="flex flex-wrap gap-5">
                {[
                  'Free 14-day trial',
                  'No credit card required',
                  'Connects in about 2 minutes',
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

            {/* Right — "what syncs automatically" trust panel.
                Deliberately not a RepuGuard panel here — see file header note. */}
            <div className="bg-brand-panel border border-brand-panelBorder rounded-2xl p-8">

              <div className="flex items-center justify-between mb-5">
                <h2 className="text-2xl font-bold text-white leading-snug">
                  What happens the moment you connect
                </h2>
              </div>

              <div className="space-y-4 mb-6">
                {[
                  {
                    label: 'Properties',
                    body: 'Name, address, check-in/out times, and bedroom count sync in immediately.',
                  },
                  {
                    label: 'Bookings',
                    body: 'Upcoming reservations sync with guest, dates, and channel — turnovers are generated automatically between them.',
                  },
                  {
                    label: 'Teammates → Crew',
                    body: 'Your Hospitable teammates sync in as FieldStay crew, mapped to the right role automatically.',
                  },
                  {
                    label: 'Reviews',
                    body: 'New reviews sync in and trigger a RepuGuard draft response, ready for your approval.',
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

              {/* Read-only trust callout — the #1 objection for any integration
                  that touches booking data. */}
              <div className="flex items-center gap-3 bg-brand-800 border border-brand-panelBorder rounded-xl px-4 py-3">
                <span className="w-5 h-5 bg-gold-300 rounded-full flex items-center justify-center flex-shrink-0">
                  <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                    <path d="M1 4l3 3 5-6" stroke="#0a1628" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <p className="text-sm text-white/52">
                  <span className="text-white font-semibold">Read-only, always.</span>
                  {' '}FieldStay never writes back to Hospitable — your account stays your system of record.
                </p>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 2 — WHITE
          Pricing
      ══════════════════════════════════════════ */}
      <div className="bg-white">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <PricingSection isLoggedIn={isLoggedIn} />
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 3 — DARK NAVY
          RepuGuard Live Demo
      ══════════════════════════════════════════ */}
      <div className="bg-brand-800 text-white">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="text-center mb-10">
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
          Features — leads with the two shipped features that aren't yet
          represented on the homepage or OwnerRez page.
      ══════════════════════════════════════════ */}
      <div className="bg-white">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <h2 className="text-3xl font-bold mb-2 text-center text-[#0a1628] font-display">
            Everything Hospitable doesn&apos;t handle.
          </h2>
          <p className="text-gray-500 text-center mb-12">
            Built specifically for the field operations side of short-term rentals.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[
              {
                num: '01',
                title: 'No-Login Vendor Portal & Work Order Invoicing',
                body: 'Dispatch a work order and your vendor gets a link — no login, no app to install. They submit their line-item invoice from their phone, you approve it with one click, and payment goes straight to their bank. No more chasing a text thread for a status update.',
              },
              {
                num: '02',
                title: 'Asset Health Scores & CapEx Forecasting',
                body: 'Every water heater, HVAC unit, and appliance gets a health score that updates daily based on age and expected lifespan. FieldStay rolls those scores into a 10-year capital plan automatically — so you catch a failing unit before it fails, not after a guest complains.',
              },
              {
                num: '03',
                title: 'Automated Turnover Management',
                body: 'Bookings from Hospitable automatically generate turnovers with crew assignments and offline-ready checklists the moment they land — no manual scheduling required.',
              },
              {
                num: '04',
                title: 'RepuGuard — Reputation Management',
                body: 'AI-generated review responses tuned to each guest\'s tone and context, with urgency scoring so nothing sits unanswered. Included in every FieldStay plan — no add-on, no extra cost.',
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
            Ready to connect?
          </h2>
          <p className="text-[#0a1628]/70 text-lg mb-10">
            It takes about 2 minutes to connect — your properties and bookings show up right after.
          </p>

          {isLoggedIn ? (
            <div className="flex flex-col items-center gap-3">
              {/* Plain <a>, not <Link> — this route 302s straight to Hospitable's
                  OAuth authorize URL. Link prefetches visible hrefs via
                  fetch() on mount, which follows the redirect into a
                  connect-src CSP violation and crashes the page on load.
                  (Same fix as app/ownerrez/page.tsx — carried forward here.) */}
              <a
                href="/api/integrations/hospitable/connect"
                className="inline-block bg-brand-800 text-white font-bold px-10 py-4 rounded-xl hover:bg-[#162a4a] transition-colors text-lg"
              >
                Connect Hospitable →
              </a>
              <p className="text-sm text-[#0a1628]/60">
                You&apos;re already signed in. One click to connect.
              </p>
            </div>
          ) : (
            <div className="max-w-sm mx-auto">
              <Link
                href="/signup?provider=hospitable&next=/api/integrations/hospitable/connect"
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
