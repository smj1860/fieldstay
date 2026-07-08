// app/ownerrez/page.tsx  —  full replacement

import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import Link from 'next/link'
import RepuGuardWrapper from '@/components/repuguard/RepuGuardWrapper'
import PricingSection from '@/components/ownerrez/PricingSection'
import FaqSection from '@/components/ownerrez/faq-section'

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
      <div className="bg-[#102246] text-white">
        <div className="max-w-6xl mx-auto px-6">

          {/* Nav */}
          <nav className="flex items-center justify-between py-5">
            <span className="text-xl font-bold">
              <span className="text-white">Field</span>
              <span className="text-[#FCD116]">Stay</span>
            </span>
            {isLoggedIn ? (
              <Link href="/dashboard" className="text-sm text-[#a0b4cc] hover:text-white transition-colors">
                Dashboard
              </Link>
            ) : (
              <Link
                href="/login?next=/api/integrations/ownerrez/connect"
                className="text-sm text-[#a0b4cc] hover:text-white transition-colors"
              >
                Log In
              </Link>
            )}
          </nav>

          {/* OwnerRez Partner Badge */}
          <div className="flex justify-center mt-6 mb-10">
            <div className="flex items-center gap-2 bg-[#0e2a52] border border-[#1e3a72] rounded-full px-4 py-2">
              <span
                className="text-white text-xs font-bold px-2 py-0.5 rounded"
                style={{ background: '#3D8B4F' }}
              >
                OR
              </span>
              <span className="text-xs font-semibold tracking-widest text-[#a0b4cc] uppercase">
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
                <span className="text-[#FCD116]">OwnerRez account</span>{' '}
                is missing.
              </h1>
              <p className="text-[#8a9bb0] text-lg leading-relaxed mb-8">
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
                    <div className="w-5 h-5 bg-[#FCD116] rounded-full flex items-center justify-center flex-shrink-0">
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
                    <span className="text-sm font-medium text-[#c8d8e8]">{item}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Right — RepuGuard: bundled exclusive, no add-on pricing */}
            <div className="bg-[#0e2a52] border border-[#1e3a72] rounded-2xl p-8">

              {/* Header row */}
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <div className="bg-[#FCD116] text-[#0a1628] text-xs font-bold px-2.5 py-1 rounded-md tracking-wider">
                    REPUGUARD
                  </div>
                  {/* "Included" pill — replaces the old trial/price framing */}
                  <span className="bg-[#1a3a2a] border border-[#2a5a3a] text-[#4ade80] text-xs font-semibold px-2.5 py-1 rounded-full">
                    Included in every plan
                  </span>
                </div>
              </div>

              <h2 className="text-2xl font-bold text-white mb-3 leading-snug">
                RepuGuard Reputation Engine
              </h2>
              <p className="text-[#8a9bb0] leading-relaxed mb-6">
                Every review deserves a response. RepuGuard reads the context of each
                guest review and generates calm, professional replies that protect your
                reputation without ever sounding defensive. Review every response before
                it posts — you stay in control.
              </p>

              {/* Feature bullets — replaces old trial/price boxes */}
              <div className="space-y-2.5 mb-6">
                {[
                  'AI-generated responses tuned to review tone & context',
                  'Urgency scoring with response-deadline badges',
                  'You approve before anything posts — always',
                ].map(feat => (
                  <div key={feat} className="flex items-start gap-3">
                    <div className="w-5 h-5 bg-[#FCD116] rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
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
                    <span className="text-sm text-[#c8d8e8] leading-snug">{feat}</span>
                  </div>
                ))}
              </div>

              {/* OwnerRez-exclusive callout — replaces old pricing rows */}
              <div className="flex items-center gap-3 bg-[#102246] border border-[#1e3a72] rounded-xl px-4 py-3">
                <span
                  className="text-white text-xs font-bold px-2 py-0.5 rounded flex-shrink-0"
                  style={{ background: '#3D8B4F' }}
                >
                  OR
                </span>
                <p className="text-sm text-[#8a9bb0]">
                  RepuGuard is{' '}
                  <span className="text-white font-semibold">exclusive to OwnerRez users</span>
                  {' '}— included in your FieldStay subscription at no extra cost.
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
          price IDs: Starter $199, Growth $379, Portfolio $599.
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
      <div className="bg-[#102246] text-white">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="text-center mb-10">
            {/* Section label */}
            <div className="inline-flex items-center gap-2 mb-4">
              <div className="bg-[#FCD116] text-[#0a1628] text-xs font-bold px-2.5 py-1 rounded-md tracking-wider">
                REPUGUARD
              </div>
              <span className="text-[#6a8aaa] text-sm">Included with every plan</span>
            </div>
            <h2 className="text-3xl font-bold mb-3 font-display">
              See RepuGuard in Action
            </h2>
            <p className="text-[#6a8aaa] text-lg max-w-xl mx-auto">
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
          <p className="text-[#5a6a7a] text-center mb-12">
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
                title: 'Inventory & Maintenance',
                body: 'Set par levels for every property. Low-stock alerts trigger purchase orders automatically. Schedule recurring maintenance — seasonal or routine — with vendor assignments built in.',
              },
              {
                num: '03',
                title: 'Owner Reporting Portal',
                body: 'Property owners get a secure, tokenized P&L portal showing revenue, expenses, and net returns by period. You share one link. They check it themselves.',
              },
              {
                num: '04',
                title: 'RepuGuard — Reputation Management',
                body: 'AI-generated review responses tuned to each guest\'s tone and context. Urgency scoring surfaces overdue responses before they cost you your rating. Included in every FieldStay plan — exclusive to OwnerRez users.',
                // Visual distinction: highlight this card subtly to signal it's exclusive/bonus
                highlight: true,
              },
            ].map(f => (
              <div
                key={f.num}
                className={
                  f.highlight
                    ? 'bg-[#0e2a52] border border-[#1e3a72] rounded-2xl p-6'
                    : 'bg-[#f8fafc] border border-[#e2e8f0] rounded-2xl p-6'
                }
              >
                <div
                  className={`text-xs font-bold mb-3 inline-block px-2 py-0.5 rounded ${
                    f.highlight
                      ? 'bg-[#FCD116] text-[#0a1628]'
                      : 'bg-[#102246] text-[#FCD116]'
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
                    f.highlight ? 'text-[#8a9bb0]' : 'text-[#5a6a7a]'
                  }`}
                >
                  {f.body}
                </p>
                {f.highlight && (
                  <div className="mt-4 flex items-center gap-2">
                    <span
                      className="text-white text-xs font-bold px-2 py-0.5 rounded"
                      style={{ background: '#3D8B4F' }}
                    >
                      OR
                    </span>
                    <span className="text-xs text-[#6a8aaa]">OwnerRez exclusive · included free</span>
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
      <div className="bg-[#FCD116]">
        <div className="max-w-6xl mx-auto px-6 py-20 text-center">
          <h2 className="text-3xl font-bold mb-3 text-[#0a1628] font-display">
            Ready to connect?
          </h2>
          <p className="text-[#0a1628]/70 text-lg mb-10">
            It takes less than 5 minutes to be fully set up.
          </p>

          {isLoggedIn ? (
            <div className="flex flex-col items-center gap-3">
              {/* Plain <a>, not <Link> — this route 302s straight to OwnerRez's
                  OAuth authorize URL. Link prefetches visible hrefs via
                  fetch() on mount, which follows the redirect into a
                  connect-src CSP violation and crashes the page on load. */}
              <a
                href="/api/integrations/ownerrez/connect"
                className="inline-block bg-[#102246] text-white font-bold px-10 py-4 rounded-xl hover:bg-[#162a4a] transition-colors text-lg"
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
                className="block w-full bg-[#102246] text-white font-bold px-8 py-4 rounded-xl hover:bg-[#162a4a] transition-colors text-lg text-center mb-4"
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