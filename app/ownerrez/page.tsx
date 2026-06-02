 'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { PLANS } from '@/lib/stripe/client'

// ── Feature tiles ──────────────────────────────────────────────────────────
const FEATURES = [
  {
    number: '01',
    title:  'Automated Turnover Management',
    desc:   'Bookings from OwnerRez automatically generate turnovers with crew assignments and offline-ready checklists. No manual scheduling — the moment a booking lands, the turnover is queued.',
  },
  {
    number: '02',
    title:  'Inventory & Maintenance',
    desc:   'Set par levels for every property. Low-stock alerts trigger purchase orders automatically. Schedule recurring maintenance — seasonal or routine — with vendor assignments built in.',
  },
  {
    number: '03',
    title:  'Owner Reporting Portal',
    desc:   'Property owners get a secure, tokenized P&L portal showing revenue, expenses, and net returns by period. You share one link. They check it themselves.',
  },
]

export default function OwnerRezLandingPage() {
  const router = useRouter()

  // Form state
  const [fullName,  setFullName]  = useState('')
  const [email,     setEmail]     = useState('')
  const [password,  setPassword]  = useState('')
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  // Auth state — handle users who are already logged in
  const [authed,        setAuthed]        = useState(false)
  const [checkingAuth,  setCheckingAuth]  = useState(true)

  // Pricing toggle
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annually'>('monthly')

  useEffect(() => {
    const check = async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) setAuthed(true)
      setCheckingAuth(false)
    }
    check()
  }, [])

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    setLoading(true)

    try {
      const supabase = createClient()
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName.trim() } },
      })

      if (signUpError) throw signUpError

      router.push('/api/integrations/ownerrez/connect')

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen" style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif" }}>

      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 flex items-center justify-between px-8 h-16"
           style={{ background: '#102246' }}>
        <span className="text-xl font-black tracking-tight" style={{ color: '#fff' }}>
          Field<span style={{ color: '#FCD116' }}>Stay</span>
        </span>
        <div className="flex items-center gap-2">
          <Link href="/login"
                className="text-sm px-4 py-2 rounded-md transition-colors"
                style={{ color: 'rgba(255,255,255,0.65)' }}
                onMouseOver={e  => (e.currentTarget.style.color = '#fff')}
                onMouseOut={e   => (e.currentTarget.style.color = 'rgba(255,255,255,0.65)')}>
            Log In
          </Link>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden px-8 py-20"
               style={{ background: '#102246' }}>

        {/* Dot grid texture */}
        <div className="absolute inset-0 pointer-events-none"
             style={{
               backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)',
               backgroundSize:  '28px 28px',
             }} />

        <div className="relative mx-auto" style={{ maxWidth: 1100 }}>

          {/* ── Two-column hero grid ──────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 mb-16">

            {/* ── Left: Messaging ──────────────────────────────────────── */}
            <div className="pt-4">

              {/* Partnership eyebrow */}
              <div className="inline-flex items-center gap-2.5 rounded-full px-4 py-1.5 mb-8"
                   style={{
                     background: 'rgba(252,209,22,0.1)',
                     border:     '1px solid rgba(252,209,22,0.3)',
                   }}>
                <span className="font-black text-xs rounded px-1.5 py-0.5 leading-none"
                      style={{ background: '#5BAC43', color: '#fff', letterSpacing: '-0.3px' }}>
                  OR
                </span>
                <span className="text-xs font-bold uppercase tracking-widest"
                      style={{ color: '#FCD116' }}>
                  OwnerRez Integration Partner
                </span>
              </div>

              {/* Headline */}
              <h1 className="font-black leading-[1.06] tracking-tight mb-6"
                  style={{
                    fontSize:      'clamp(34px, 4.5vw, 52px)',
                    color:         '#fff',
                    letterSpacing: '-1.5px',
                    maxWidth:      560,
                  }}>
                The operations layer your{' '}
                <span style={{ color: '#FCD116' }}>OwnerRez account</span>{' '}
                is missing.
              </h1>

              {/* Subhead */}
              <p className="mb-10 leading-relaxed"
                 style={{ fontSize: 17, color: 'rgba(255,255,255,0.6)', maxWidth: 500 }}>
                FieldStay connects directly to your OwnerRez bookings to automate everything your team handles on the ground — fully operational offline automated turnover management,
                crew checklists, asset inventory tracking with par levels, and field maintenance schedules and work orders.
              </p>

              {/* Trust signals */}
              <div className="flex flex-wrap gap-6">
                {[
                  'Free 14-day trial',
                  'No credit card required',
                  'Connects in minutes',
                ].map((signal) => (
                  <div key={signal} className="flex items-center gap-2">
                    <span className="flex items-center justify-center rounded-full font-black text-xs"
                          style={{
                            width:      18,
                            height:     18,
                            minWidth:   18,
                            background: '#FCD116',
                            color:      '#102246',
                            lineHeight: '18px',
                          }}>
                      ✓
                    </span>
                    <span className="text-sm font-medium"
                          style={{ color: 'rgba(255,255,255,0.7)' }}>
                      {signal}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Right: RepuGuard callout card ─────────────────────────── */}
            <div className="rounded-2xl p-8 flex flex-col"
                 style={{
                   background:  'rgba(252,209,22,0.06)',
                   border:      '1px solid rgba(252,209,22,0.25)',
                 }}>

              {/* Heading */}
              <h2 className="font-black text-2xl mb-1"
                  style={{ color: '#fff', letterSpacing: '-0.5px' }}>
                RepuGuard Reputation Engine
              </h2>
              <p className="text-sm italic mb-5"
                 style={{ color: '#FCD116' }}>
                Exclusively for OwnerRez users
              </p>

              {/* Body */}
              <p className="leading-relaxed mb-6"
                 style={{ fontSize: 15, color: 'rgba(255,255,255,0.7)' }}>
                Every review deserves a response. RepuGuard reads the context of each guest review
                and generates calm, professional replies that protect your reputation without ever
                sounding defensive — automatically. Review every response before it posts. You stay
                in control.
              </p>

              {/* Pricing callout */}
              <div className="rounded-xl px-5 py-4 mt-auto"
                   style={{
                     background: 'rgba(252,209,22,0.1)',
                     border:     '1px solid rgba(252,209,22,0.2)',
                   }}>
                <p className="font-bold text-base mb-1"
                   style={{ color: '#FCD116' }}>
                  🎁 3 Months Free with every FieldStay subscription
                </p>
                <p className="text-sm font-bold"
                   style={{ color: '#fff' }}>
                  Then just <span style={{ fontSize: 18 }}>$15</span>/mo for life if you activate before Jan 1
                </p>
                <p className="text-xs mt-1"
                   style={{ color: 'rgba(255,255,255,0.5)' }}>
                  Regular price $29/mo
                </p>
              </div>
            </div>

          </div>

          {/* ── Pricing section ───────────────────────────────────────── */}
          <div className="mb-16">
            <div className="text-center mb-8">
              <h2 className="font-black tracking-tight mb-4"
                  style={{
                    fontSize:      'clamp(24px, 3vw, 32px)',
                    color:         '#fff',
                    letterSpacing: '-1px',
                  }}>
                Simple, transparent pricing.
              </h2>

              {/* Toggle */}
              <div className="inline-flex rounded-xl p-1"
                   style={{ background: 'rgba(255,255,255,0.08)' }}>
                {(['monthly', 'annually'] as const).map((cycle) => (
                  <button
                    key={cycle}
                    onClick={() => setBillingCycle(cycle)}
                    className="px-5 py-2 rounded-lg text-sm font-semibold transition-all"
                    style={{
                      background: billingCycle === cycle ? '#FCD116' : 'transparent',
                      color:      billingCycle === cycle ? '#102246' : 'rgba(255,255,255,0.6)',
                      border:     'none',
                      cursor:     'pointer',
                    }}>
                    {cycle === 'monthly' ? 'Monthly' : 'Annually'}
                    {cycle === 'annually' && (
                      <span className="ml-1.5 text-xs font-bold"
                            style={{ color: billingCycle === 'annually' ? '#102246' : '#FCD116' }}>
                        2 months free
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-6">
              {/* Pro */}
              <div className="rounded-2xl p-7"
                   style={{
                     background: 'rgba(255,255,255,0.05)',
                     border:     '1px solid rgba(255,255,255,0.1)',
                   }}>
                <p className="font-black text-lg mb-1" style={{ color: '#fff' }}>
                  {PLANS.pro.name}
                </p>
                <p className="text-xs mb-4" style={{ color: 'rgba(255,255,255,0.45)' }}>
                  {PLANS.pro.description}
                </p>
                <p className="font-black mb-1" style={{ color: '#fff' }}>
                  <span style={{ fontSize: 36, letterSpacing: '-1px' }}>
                    ${billingCycle === 'monthly' ? PLANS.pro.monthlyPrice : Math.round(PLANS.pro.annualPrice / 12)}
                  </span>
                  <span className="text-sm font-normal ml-1" style={{ color: 'rgba(255,255,255,0.45)' }}>
                    /mo
                  </span>
                </p>
                {billingCycle === 'annually' && (
                  <p className="text-xs mb-4" style={{ color: 'rgba(255,255,255,0.45)' }}>
                    ${PLANS.pro.annualPrice}/yr · saves ${PLANS.pro.monthlyPrice * 12 - PLANS.pro.annualPrice}
                  </p>
                )}
              </div>

              {/* Growth — highlighted */}
              <div className="rounded-2xl p-7 relative"
                   style={{
                     background: 'rgba(252,209,22,0.08)',
                     border:     '1.5px solid rgba(252,209,22,0.4)',
                   }}>
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="text-xs font-bold px-3 py-1 rounded-full"
                        style={{ background: '#FCD116', color: '#102246' }}>
                    Most Popular
                  </span>
                </div>
                <p className="font-black text-lg mb-1" style={{ color: '#fff' }}>
                  {PLANS.growth.name}
                </p>
                <p className="text-xs mb-4" style={{ color: 'rgba(255,255,255,0.45)' }}>
                  {PLANS.growth.description}
                </p>
                <p className="font-black mb-1" style={{ color: '#fff' }}>
                  <span style={{ fontSize: 36, letterSpacing: '-1px' }}>
                    ${billingCycle === 'monthly' ? PLANS.growth.monthlyPrice : Math.round(PLANS.growth.annualPrice / 12)}
                  </span>
                  <span className="text-sm font-normal ml-1" style={{ color: 'rgba(255,255,255,0.45)' }}>
                    /mo
                  </span>
                </p>
                {billingCycle === 'annually' && (
                  <p className="text-xs mb-4" style={{ color: 'rgba(255,255,255,0.45)' }}>
                    ${PLANS.growth.annualPrice}/yr · saves ${PLANS.growth.monthlyPrice * 12 - PLANS.growth.annualPrice}
                  </p>
                )}
              </div>

              {/* Enterprise */}
              <div className="rounded-2xl p-7"
                   style={{
                     background: 'rgba(255,255,255,0.05)',
                     border:     '1px solid rgba(255,255,255,0.1)',
                   }}>
                <p className="font-black text-lg mb-1" style={{ color: '#fff' }}>
                  {PLANS.enterprise.name}
                </p>
                <p className="text-xs mb-4" style={{ color: 'rgba(255,255,255,0.45)' }}>
                  {PLANS.enterprise.description}
                </p>
                <p className="font-black mb-4" style={{ color: '#fff', fontSize: 20 }}>
                  Contact us
                </p>
                <a href="mailto:hello@fieldstay.app"
                   className="text-xs underline"
                   style={{ color: '#FCD116' }}>
                  hello@fieldstay.app
                </a>
              </div>
            </div>

            {/* RepuGuard add-on row */}
            <div className="rounded-2xl px-7 py-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                 style={{
                   background: 'rgba(252,209,22,0.06)',
                   border:     '1px solid rgba(252,209,22,0.2)',
                 }}>
              <div>
                <p className="font-bold text-base" style={{ color: '#fff' }}>
                  + RepuGuard Reputation Engine
                  <span className="ml-2 text-xs font-normal italic" style={{ color: '#FCD116' }}>
                    Add-on · OwnerRez exclusive
                  </span>
                </p>
                <p className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.55)' }}>
                  AI-generated review responses, reviewed by you before posting.
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="font-black" style={{ color: '#FCD116' }}>
                  <span style={{ fontSize: 22 }}>$15</span>
                  <span className="text-sm font-normal" style={{ color: 'rgba(255,255,255,0.45)' }}>/mo founding</span>
                </p>
                <p className="text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
                  Regular $29/mo · 🎁 3-month trial included
                </p>
              </div>
            </div>
          </div>

          {/* ── Full-width CTA / signup section ───────────────────────── */}
          <div className="max-w-[480px] mx-auto">
            <div className="rounded-2xl p-8"
                 style={{ background: '#fff', boxShadow: '0 24px 64px rgba(0,0,0,0.3)' }}>

              {checkingAuth ? (
                <div className="space-y-3 animate-pulse">
                  <div className="h-5 rounded" style={{ background: '#F3F4F6', width: '60%' }} />
                  <div className="h-4 rounded" style={{ background: '#F3F4F6', width: '80%' }} />
                  <div className="h-11 rounded-lg mt-6" style={{ background: '#F3F4F6' }} />
                  <div className="h-11 rounded-lg" style={{ background: '#F3F4F6' }} />
                  <div className="h-11 rounded-lg" style={{ background: '#F3F4F6' }} />
                  <div className="h-12 rounded-lg mt-2" style={{ background: '#F3F4F6' }} />
                </div>

              ) : authed ? (
                <div className="text-center">
                  <div className="inline-flex items-center justify-center rounded-full mb-4"
                       style={{ width: 52, height: 52, background: 'rgba(16,34,70,0.08)' }}>
                    <span className="font-black text-xl" style={{ color: '#102246' }}>✓</span>
                  </div>
                  <h2 className="font-black mb-2 tracking-tight"
                      style={{ fontSize: 20, color: '#111827', letterSpacing: '-0.5px' }}>
                    You&apos;re already signed in
                  </h2>
                  <p className="text-sm mb-7" style={{ color: '#6B7280', lineHeight: 1.6 }}>
                    Click below to connect your OwnerRez account to FieldStay.
                  </p>
                  <a href="/api/integrations/ownerrez/connect"
                     className="block w-full text-center rounded-xl font-bold text-sm py-3.5 transition-opacity hover:opacity-90"
                     style={{ background: '#FCD116', color: '#102246' }}>
                    Connect OwnerRez Account →
                  </a>
                  <p className="text-xs mt-5" style={{ color: '#9CA3AF' }}>
                    Not you?{' '}
                    <Link href="/login" className="underline underline-offset-2" style={{ color: '#6B7280' }}>
                      Sign in to a different account
                    </Link>
                  </p>
                </div>

              ) : (
                <>
                  <h2 className="font-black mb-1 tracking-tight"
                      style={{ fontSize: 20, color: '#111827', letterSpacing: '-0.5px' }}>
                    Create your FieldStay account
                  </h2>
                  <p className="text-sm mb-6" style={{ color: '#6B7280' }}>
                    Connect your OwnerRez account in the next step.
                  </p>

                  {error && (
                    <div className="rounded-lg px-4 py-3 mb-5 text-sm"
                         style={{
                           background:  '#FEF2F2',
                           border:      '1px solid #FECACA',
                           color:       '#B91C1C',
                         }}>
                      {error}
                    </div>
                  )}

                  <form onSubmit={handleSignup} className="space-y-4">

                    <div>
                      <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide"
                             style={{ color: '#374151' }}>
                        Full Name
                      </label>
                      <input
                        type="text"
                        required
                        autoComplete="name"
                        value={fullName}
                        onChange={e => setFullName(e.target.value)}
                        placeholder="Jane Smith"
                        className="w-full rounded-lg px-4 py-3 text-sm outline-none transition-colors"
                        style={{ border: '1.5px solid #E5E7EB', color: '#111827', background: '#fff' }}
                        onFocus={e  => (e.currentTarget.style.borderColor = '#102246')}
                        onBlur={e   => (e.currentTarget.style.borderColor = '#E5E7EB')}
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide"
                             style={{ color: '#374151' }}>
                        Email
                      </label>
                      <input
                        type="email"
                        required
                        autoComplete="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        placeholder="jane@example.com"
                        className="w-full rounded-lg px-4 py-3 text-sm outline-none transition-colors"
                        style={{ border: '1.5px solid #E5E7EB', color: '#111827', background: '#fff' }}
                        onFocus={e  => (e.currentTarget.style.borderColor = '#102246')}
                        onBlur={e   => (e.currentTarget.style.borderColor = '#E5E7EB')}
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide"
                             style={{ color: '#374151' }}>
                        Password
                      </label>
                      <input
                        type="password"
                        required
                        autoComplete="new-password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="At least 8 characters"
                        className="w-full rounded-lg px-4 py-3 text-sm outline-none transition-colors"
                        style={{ border: '1.5px solid #E5E7EB', color: '#111827', background: '#fff' }}
                        onFocus={e  => (e.currentTarget.style.borderColor = '#102246')}
                        onBlur={e   => (e.currentTarget.style.borderColor = '#E5E7EB')}
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full rounded-xl font-bold text-sm py-3.5 mt-2 transition-opacity"
                      style={{
                        background: loading ? '#E5E7EB' : '#FCD116',
                        color:      loading ? '#9CA3AF' : '#102246',
                        cursor:     loading ? 'not-allowed' : 'pointer',
                        border:     'none',
                      }}>
                      {loading ? 'Creating account…' : 'Create Account & Connect OwnerRez →'}
                    </button>

                  </form>

                  <div className="flex items-center gap-3 my-5">
                    <div className="flex-1 h-px" style={{ background: '#F3F4F6' }} />
                    <span className="text-xs" style={{ color: '#D1D5DB' }}>or</span>
                    <div className="flex-1 h-px" style={{ background: '#F3F4F6' }} />
                  </div>

                  <p className="text-center text-sm" style={{ color: '#6B7280' }}>
                    Already have an account?{' '}
                    <Link href="/login" className="font-semibold underline underline-offset-2" style={{ color: '#102246' }}>
                      Log in
                    </Link>
                  </p>

                  <p className="text-center text-xs mt-5" style={{ color: '#9CA3AF' }}>
                    14-day free trial · No credit card required
                  </p>
                </>
              )}
            </div>
          </div>

        </div>
      </section>

      {/* ── Features ────────────────────────────────────────────────────── */}
      <section className="px-8 py-20" style={{ background: '#0c1d3a' }}>
        <div className="mx-auto" style={{ maxWidth: 1100 }}>

          <div className="text-center mb-14">
            <h2 className="font-black tracking-tight mb-3"
                style={{
                  fontSize:      'clamp(26px, 3.5vw, 36px)',
                  color:         '#fff',
                  letterSpacing: '-1px',
                }}>
              Everything OwnerRez doesn&apos;t handle.
            </h2>
            <p className="text-sm" style={{ color: 'rgba(255,255,255,0.45)' }}>
              Built specifically for the field operations side of short-term rentals.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {FEATURES.map((f) => (
              <div key={f.number}
                   className="rounded-2xl p-7"
                   style={{
                     background: 'rgba(255,255,255,0.05)',
                     border:     '1px solid rgba(255,255,255,0.08)',
                   }}>
                <div className="font-black mb-4 leading-none"
                     style={{
                       fontSize:      44,
                       color:         'rgba(252,209,22,0.18)',
                       letterSpacing: '-2px',
                     }}>
                  {f.number}
                </div>
                <p className="font-bold mb-3" style={{ fontSize: 16, color: '#fff', letterSpacing: '-0.3px' }}>
                  {f.title}
                </p>
                <p className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  {f.desc}
                </p>
              </div>
            ))}
          </div>

        </div>
      </section>

      {/* ── Bottom CTA ──────────────────────────────────────────────────── */}
      <section className="px-8 py-16 text-center"
               style={{ background: '#F8F9FA', borderTop: '1px solid #E5E7EB' }}>
        <p className="font-black mb-1 tracking-tight"
           style={{
             fontSize:      'clamp(22px, 3vw, 30px)',
             color:         '#102246',
             letterSpacing: '-0.75px',
           }}>
          Ready to connect?
        </p>
        <p className="text-sm mb-7" style={{ color: '#6B7280' }}>
          It takes less than 5 minutes to be fully set up.
        </p>
        <a href="#"
           onClick={e => {
             e.preventDefault()
             window.scrollTo({ top: 0, behavior: 'smooth' })
           }}
           className="inline-block rounded-xl font-bold text-sm px-8 py-3.5 transition-opacity hover:opacity-90"
           style={{ background: '#102246', color: '#FCD116' }}>
          Get Started Free →
        </a>
        <p className="text-xs mt-4" style={{ color: '#9CA3AF' }}>
          Questions?{' '}
          <a href="mailto:hello@fieldstay.app" className="underline underline-offset-2" style={{ color: '#6B7280' }}>
            hello@fieldstay.app
          </a>
        </p>
      </section>

    </div>
  )
}
