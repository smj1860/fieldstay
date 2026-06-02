import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import Link from 'next/link'
import dynamic from 'next/dynamic'

// Pre-baked sandbox — loaded client-side only, zero API calls, zero Anthropic SDK
const RepuGuardSandbox = dynamic(
  () => import('@/components/repuguard/RepuGuardSandbox'),
  {
    ssr: false,
    loading: () => (
      <div className="h-96 bg-[#0a1628] border border-[#0e2040] rounded-2xl animate-pulse" />
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
    <div className="min-h-screen bg-[#0a1628] text-white">

      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-5 max-w-6xl mx-auto">
        <span className="text-xl font-bold">
          <span className="text-white">Field</span>
          <span className="text-[#FCD116]">Stay</span>
        </span>
        {isLoggedIn ? (
          <Link
            href="/dashboard"
            className="text-sm text-[#a0b4cc] hover:text-white transition-colors"
          >
            Dashboard
          </Link>
        ) : (
          <Link
            href="/login"
            className="text-sm text-[#a0b4cc] hover:text-white transition-colors"
          >
            Log In
          </Link>
        )}
      </nav>

      <main className="max-w-6xl mx-auto px-6">

        {/* OwnerRez badge */}
        <div className="flex justify-center mt-8 mb-10">
          <div className="flex items-center gap-2 bg-[#0e1e3e] border border-[#1e3a6e] rounded-full px-4 py-2">
            <span className="bg-[#FCD116] text-[#0a1628] text-xs font-bold px-2 py-0.5 rounded">
              OR
            </span>
            <span className="text-xs font-semibold tracking-widest text-[#a0b4cc] uppercase">
              OwnerRez Integration Partner
            </span>
          </div>
        </div>

        {/* ─── Hero — two equal columns ─── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-start mb-20">

          {/* Left — FieldStay pitch */}
          <div>
            <h1 className="text-4xl lg:text-5xl font-bold leading-tight mb-6">
              The operations layer your{' '}
              <span className="text-[#FCD116]">OwnerRez account</span>{' '}
              is missing.
            </h1>
            <p className="text-[#a0b4cc] text-lg leading-relaxed mb-8">
              FieldStay connects directly to your OwnerRez bookings to automate
              everything your team handles on the ground — fully operational offline
              automated turnover management, crew checklists, asset inventory tracking
              with par levels, and field maintenance schedules and work orders.
            </p>
            <div className="flex flex-wrap gap-6">
              {['Free 14-day trial', 'No credit card required', 'Connects in minutes'].map(item => (
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

          {/* Right — RepuGuard exclusive block */}
          <div className="bg-[#0c1e3a] border border-[#1e3a6e] rounded-2xl p-8">
            <div className="flex items-center gap-3 mb-5">
              <div className="bg-[#FCD116] text-[#0a1628] text-xs font-bold px-2.5 py-1 rounded-md tracking-wider">
                REPUGUARD
              </div>
              <span className="text-[#FCD116] text-sm italic font-medium tracking-wide">
                Exclusively for OwnerRez users
              </span>
            </div>

            <h2 className="text-2xl font-bold text-white mb-4 leading-snug">
              RepuGuard Reputation Engine
            </h2>

            <p className="text-[#a0b4cc] leading-relaxed mb-7">
              Every review deserves a response. RepuGuard reads the context of each
              guest review and generates calm, professional replies that protect your
              reputation without ever sounding defensive — automatically. Review every
              response before it posts. You stay in control.
            </p>

            <div className="space-y-3">
              <div className="flex items-start gap-3 bg-[#0a1628] rounded-xl p-4 border border-[#1a3a6a]">
                <span className="text-xl leading-none mt-0.5">🎁</span>
                <div>
                  <div className="font-bold text-white">3 Months Free</div>
                  <div className="text-sm text-[#6a8aaa]">
                    included with every FieldStay subscription
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between bg-[#0a1628] rounded-xl px-4 py-3 border border-[#1a3a6a]">
                <div>
                  <span className="text-[#FCD116] font-bold text-lg">$15/mo for life</span>
                  <span className="text-[#6a8aaa] text-sm ml-2">if you activate before Jan 1</span>
                </div>
                <span className="text-sm text-[#3a5a7a] line-through">$29/mo</span>
              </div>
            </div>
          </div>
        </div>

        {/* ─── RepuGuard Sandbox ─── */}
        <div className="mb-24">
          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold mb-3">See RepuGuard in Action</h2>
            <p className="text-[#6a8aaa] text-lg max-w-xl mx-auto">
              Choose a review scenario and watch RepuGuard generate a response in real time.
            </p>
          </div>
          <RepuGuardSandbox />
        </div>

        {/* ─── Features ─── */}
        <div className="mb-24">
          <h2 className="text-3xl font-bold mb-2 text-center">
            Everything OwnerRez doesn&apos;t handle.
          </h2>
          <p className="text-[#6a8aaa] text-center mb-12">
            Built specifically for the field operations side of short-term rentals.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
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
              <div
                key={f.num}
                className="bg-[#0c1e3a] border border-[#1e3a6e] rounded-2xl p-6"
              >
                <div className="text-[#FCD116] font-bold text-sm mb-3">{f.num}</div>
                <h3 className="font-bold text-lg mb-3">{f.title}</h3>
                <p className="text-[#6a8aaa] text-sm leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ─── Pricing ─── */}
        {/* TODO: Replace $XX placeholders with your actual plan names, prices, and feature lists */}
        <div className="mb-24">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-3">Simple, transparent pricing</h2>
            <p className="text-[#6a8aaa]">Start free. No credit card required.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            {[
              {
                name: 'Starter',
                price: '$XX',
                description: 'For independent owners managing a small portfolio.',
                features: [
                  'Up to X properties',
                  'Turnover automation',
                  'Crew checklists',
                  'Email support',
                ],
                highlight: false,
              },
              {
                name: 'Growth',
                price: '$XX',
                description: 'For growing operations that need more scale.',
                features: [
                  'Up to X properties',
                  'Everything in Starter',
                  'Inventory & POs',
                  'Maintenance schedules',
                  'Owner portal',
                ],
                highlight: true,
              },
              {
                name: 'Pro',
                price: '$XX',
                description: 'For professional managers running a full operation.',
                features: [
                  'Unlimited properties',
                  'Everything in Growth',
                  'Priority support',
                  'API access',
                ],
                highlight: false,
              },
            ].map(plan => (
              <div
                key={plan.name}
                className={`rounded-2xl p-6 border relative ${
                  plan.highlight
                    ? 'bg-[#0e2448] border-[#FCD116]'
                    : 'bg-[#0c1e3a] border-[#1e3a6e]'
                }`}
              >
                {plan.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#FCD116] text-[#0a1628] text-xs font-bold px-3 py-1 rounded-full whitespace-nowrap">
                    Most Popular
                  </div>
                )}
                <div className="mb-5">
                  <div className="font-bold text-lg mb-1">{plan.name}</div>
                  <div className="flex items-end gap-1 mb-2">
                    <span className="text-3xl font-bold">{plan.price}</span>
                    <span className="text-[#6a8aaa] mb-1 text-sm">/mo</span>
                  </div>
                  <p className="text-[#6a8aaa] text-sm">{plan.description}</p>
                </div>
                <ul className="space-y-2.5 mb-6">
                  {plan.features.map(f => (
                    <li key={f} className="flex items-center gap-2 text-sm text-[#a0b4cc]">
                      <svg width="12" height="10" viewBox="0 0 12 10" fill="none" className="flex-shrink-0">
                        <path
                          d="M1 5l4 4 6-8"
                          stroke="#FCD116"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href={
                    isLoggedIn
                      ? '/api/integrations/ownerrez/connect'
                      : '/signup?provider=ownerrez&next=/api/integrations/ownerrez/connect'
                  }
                  className={`block text-center py-3 rounded-xl text-sm font-bold transition-colors ${
                    plan.highlight
                      ? 'bg-[#FCD116] text-[#0a1628] hover:bg-[#EAB800]'
                      : 'bg-[#0a1628] border border-[#1e3a6e] text-[#a0b4cc] hover:border-[#FCD116] hover:text-white'
                  }`}
                >
                  Start free trial
                </Link>
              </div>
            ))}
          </div>

          {/* RepuGuard add-on row */}
          <div className="bg-[#0c1e3a] border border-[#1e3a6e] rounded-2xl p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="flex items-start md:items-center gap-4">
              <div className="bg-[#FCD116] text-[#0a1628] text-xs font-bold px-2.5 py-1 rounded-md tracking-wider flex-shrink-0 mt-0.5 md:mt-0">
                ADD-ON
              </div>
              <div>
                <div className="font-bold text-white mb-0.5">RepuGuard Reputation Engine</div>
                <div className="text-sm text-[#6a8aaa]">
                  Exclusively for OwnerRez users · 3 months free with any plan · then{' '}
                  <span className="text-[#FCD116] font-semibold">$15/mo for life</span>{' '}
                  if activated before Jan 1{' '}
                  <span className="line-through text-[#3a5a7a] ml-1">$29/mo</span>
                </div>
              </div>
            </div>
            <div className="text-xs text-[#2a4060] italic flex-shrink-0">
              Included automatically on sign-up
            </div>
          </div>
        </div>

        {/* ─── Auth-aware CTA ─── */}
        <div className="text-center pb-24">
          <h2 className="text-2xl font-bold mb-2">Ready to connect?</h2>
          <p className="text-[#6a8aaa] mb-8">It takes less than 5 minutes to be fully set up.</p>

          {isLoggedIn ? (
            <div className="flex flex-col items-center gap-3">
              <Link
                href="/api/integrations/ownerrez/connect"
                className="inline-block bg-[#FCD116] text-[#0a1628] font-bold px-10 py-4 rounded-xl hover:bg-[#EAB800] transition-colors text-lg"
              >
                Connect OwnerRez →
              </Link>
              <p className="text-sm text-[#3a5a7a]">
                You&apos;re already signed in. One click to connect.
              </p>
            </div>
          ) : (
            <div className="max-w-sm mx-auto">
              <Link
                href="/signup?provider=ownerrez&next=/api/integrations/ownerrez/connect"
                className="block w-full bg-[#FCD116] text-[#0a1628] font-bold px-8 py-4 rounded-xl hover:bg-[#EAB800] transition-colors text-lg text-center mb-4"
              >
                Create your FieldStay account
              </Link>
              <p className="text-sm text-[#3a5a7a]">
                Already have an account?{' '}
                <Link
                  href="/login"
                  className="text-[#a0b4cc] hover:text-white transition-colors"
                >
                  Log in
                </Link>
              </p>
            </div>
          )}

          <p className="mt-10 text-sm text-[#3a5a7a]">
            Questions?{' '}
            <a
              href="mailto:hello@fieldstay.app"
              className="text-[#6a8aaa] hover:text-white transition-colors"
            >
              hello@fieldstay.app
            </a>
          </p>
        </div>

      </main>
    </div>
  )
}
