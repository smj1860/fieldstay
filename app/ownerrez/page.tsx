import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import PricingSection from '@/components/ownerrez/PricingSection'

const RepuGuardWrapper = dynamic(
  () => import('@/components/repuguard/RepuGuardWrapper'),
  {
    ssr: false,
    loading: () => (
      <div className="h-96 bg-[#0c1e3a] border border-[#1e3a6e] rounded-2xl animate-pulse" />
    ),
  }
)

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
      <div className="bg-[#0a1628] text-white">
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
              <Link href="/login" className="text-sm text-[#a0b4cc] hover:text-white transition-colors">
                Log In
              </Link>
            )}
          </nav>

          {/* Badge */}
          {/* NOTE: #3D8B4F is an approximation of OwnerRez brand green.
              Confirm exact hex with your OwnerRez partnership contact. */}
          <div className="flex justify-center mt-6 mb-10">
            <div className="flex items-center gap-2 bg-[#0c1e3a] border border-[#1e3a6e] rounded-full px-4 py-2">
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

            {/* Left */}
            <div>
              <h1 className="text-4xl lg:text-5xl font-bold leading-tight mb-6">
                The operations layer your{' '}
                <span className="text-[#FCD116]">OwnerRez account</span>{' '}
                is missing.
              </h1>
              <p className="text-[#8a9bb0] text-lg leading-relaxed mb-8">
                FieldStay connects directly to your OwnerRez bookings to automate
                everything your team handles on the ground — fully operational offline
                automated turnover management, crew checklists, asset inventory tracking
                with par levels, and field maintenance schedules and work orders.
              </p>
              <div className="flex flex-wrap gap-5">
                {['Free 14-day trial', 'No credit card required', 'Connects in minutes'].map(item => (
                  <div key={item} className="flex items-center gap-2">
                    <div className="w-5 h-5 bg-[#FCD116] rounded-full flex items-center justify-center flex-shrink-0">
                      <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                        <path d="M1 4l3 3 5-6" stroke="#0a1628" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <span className="text-sm font-medium text-[#c8d8e8]">{item}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Right — RepuGuard */}
            <div className="bg-[#0c1e3a] border border-[#1e3a6e] rounded-2xl p-8">
              <div className="flex items-center gap-3 mb-5">
                <div className="bg-[#FCD116] text-[#0a1628] text-xs font-bold px-2.5 py-1 rounded-md tracking-wider">
                  REPUGUARD
                </div>
                <span className="text-[#FCD116] text-sm italic font-medium">
                  Exclusively for OwnerRez users
                </span>
              </div>
              <h2 className="text-2xl font-bold text-white mb-4 leading-snug">
                RepuGuard Reputation Engine
              </h2>
              <p className="text-[#8a9bb0] leading-relaxed mb-7">
                Every review deserves a response. RepuGuard reads the context of each
                guest review and generates calm, professional replies that protect your
                reputation without ever sounding defensive — automatically. Review every
                response before it posts. You stay in control.
              </p>
              <div className="space-y-3">
                <div className="flex items-start gap-3 bg-[#0a1628] rounded-xl p-4 border border-[#162a4a]">
                  <span className="text-xl leading-none mt-0.5">🎁</span>
                  <div>
                    <div className="font-bold text-white">3 Months Free</div>
                    <div className="text-sm text-[#6a8aaa]">included with every FieldStay subscription</div>
                  </div>
                </div>
                <div className="flex items-center justify-between bg-[#0a1628] rounded-xl px-4 py-3 border border-[#162a4a]">
                  <div>
                    <span className="text-[#FCD116] font-bold text-lg">$15/mo for life</span>
                    <span className="text-[#6a8aaa] text-sm ml-2">if you activate before Jan 1</span>
                  </div>
                  <span className="text-sm text-[#2a4060] line-through">$29/mo</span>
                </div>
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
          RepuGuard Sandbox Demo
      ══════════════════════════════════════════ */}
      <div className="bg-[#0a1628] text-white">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold mb-3">See RepuGuard in Action</h2>
            <p className="text-[#6a8aaa] text-lg max-w-xl mx-auto">
              Choose a review scenario and watch RepuGuard generate a response in real time.
            </p>
          </div>
          <RepuGuardWrapper />
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 4 — WHITE
          Features
      ══════════════════════════════════════════ */}
      <div className="bg-white">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <h2 className="text-3xl font-bold mb-2 text-center text-[#0a1628]">
            Everything OwnerRez doesn&apos;t handle.
          </h2>
          <p className="text-[#5a6a7a] text-center mb-12">
            Built specifically for the field operations side of short-term rentals.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
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
            ].map(f => (
              <div key={f.num} className="bg-[#f8fafc] border border-[#e2e8f0] rounded-2xl p-6">
                <div className="text-[#FCD116] font-bold text-sm mb-3 bg-[#0a1628] inline-block px-2 py-0.5 rounded">
                  {f.num}
                </div>
                <h3 className="font-bold text-lg mb-3 text-[#0a1628]">{f.title}</h3>
                <p className="text-[#5a6a7a] text-sm leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 5 — YELLOW
          CTA
      ══════════════════════════════════════════ */}
      <div className="bg-[#FCD116]">
        <div className="max-w-6xl mx-auto px-6 py-20 text-center">
          <h2 className="text-3xl font-bold mb-3 text-[#0a1628]">
            Ready to connect?
          </h2>
          <p className="text-[#0a1628]/70 text-lg mb-10">
            It takes less than 5 minutes to be fully set up.
          </p>

          {isLoggedIn ? (
            <div className="flex flex-col items-center gap-3">
              <Link
                href="/api/integrations/ownerrez/connect"
                className="inline-block bg-[#0a1628] text-white font-bold px-10 py-4 rounded-xl hover:bg-[#162a4a] transition-colors text-lg"
              >
                Connect OwnerRez →
              </Link>
              <p className="text-sm text-[#0a1628]/60">
                You&apos;re already signed in. One click to connect.
              </p>
            </div>
          ) : (
            <div className="max-w-sm mx-auto">
              <Link
                href="/signup?provider=ownerrez&next=/api/integrations/ownerrez/connect"
                className="block w-full bg-[#0a1628] text-white font-bold px-8 py-4 rounded-xl hover:bg-[#162a4a] transition-colors text-lg text-center mb-4"
              >
                Create your FieldStay account
              </Link>
              <p className="text-sm text-[#0a1628]/60">
                Already have an account?{' '}
                <Link href="/login" className="text-[#0a1628] font-semibold underline hover:no-underline transition-all">
                  Log in
                </Link>
              </p>
            </div>
          )}

          <p className="mt-10 text-sm text-[#0a1628]/50">
            Questions?{' '}
            <a href="mailto:hello@fieldstay.app" className="text-[#0a1628]/70 hover:text-[#0a1628] transition-colors">
              hello@fieldstay.app
            </a>
          </p>
        </div>
      </div>

    </div>
  )
}
