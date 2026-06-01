'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// ── Primary Core Features (The main product) ──────────────────────────────
const CORE_FEATURES = [
  {
    number: '01',
    title:  'Automated Turnover Management',
    desc:   'Bookings from OwnerRez automatically generate turnovers with crew assignments and offline-ready checklists. No manual scheduling — the moment a booking lands, the turnover is queued.',
  },
  {
    number: '02',
    title:  'Inventory & Asset Tracking',
    desc:   'Set par levels for every property. Low-stock alerts trigger purchase orders automatically. Keep your field teams stocked without the spreadsheets.',
  },
  {
    number: '03',
    title:  'Field Maintenance & Vendors',
    desc:   'Schedule recurring seasonal maintenance or drop in unexpected work orders. Assign external vendors and track their progress entirely inside the system.',
  },
  {
    number: '04',
    title:  'Owner Reporting Portal',
    desc:   'Property owners get a secure, tokenized P&L portal showing revenue, expenses, and net returns by period. You share one link. They check it themselves.',
  },
]

// ── Sandbox Demo Dataset (RepuGuard Optional Module) ───────────────────────
const SANDBOX_SCENARIOS = {
  glowing: {
    label: '5-Star Review',
    guest: 'David • The Lakehouse',
    text: '"Absolutely incredible stay! The back deck views at sunset were breathtaking. We spent every night out there. Also, a huge shoutout to Sarah who helped us coordinate an early check-in so our toddler could nap. Clean, spacious, and perfect."',
    reply: 'Hi David, thank you so much for the wonderful review! We\'re thrilled you got to experience those breathtaking sunset views from the back deck—they really are the best part of the property. I\'ll be sure to pass your kind words along to Sarah; she loves going above and beyond to make sure families have a smooth check-in. We would love to host your family again for another lakeside getaway soon!'
  },
  critical: {
    label: '4-Star Review',
    guest: 'Emily • Downtown Loft',
    text: '"Great location, super stylish, and walking distance to everything. The bed was incredibly comfortable. Only giving 4 stars because we couldn\'t find the remote for the living room TV and the coffee pods ran out on day two."',
    reply: 'Hi Emily, thank you for staying with us and for highlighting the stylish space and comfortable bed! We are so glad our downtown location worked out perfectly for your walks. I do apologize for the frustration with the living room remote and the coffee shortage. We want every guest to have a flawless experience, so we\'ve already tracked down that remote and stocked the closet with extra coffee pods for future stays. If you ever head back this way, please reach out directly—we\'d love the chance to welcome you back for a perfect stay.'
  },
  mitigation: {
    label: '3-Star Review',
    guest: 'Marcus • Mountain Cabin',
    text: '"The cabin itself is beautiful and the hot tub was clean. However, the gravel driveway is incredibly steep and our sedan struggled to get up it. Also, the WiFi was too slow to stream movies in the evening."',
    reply: 'Hi Marcus, thank you for taking the time to share your feedback. We are glad you found the cabin beautiful and enjoyed the hot tub. Thank you for letting us know how your sedan handled the gravel driveway; that will help us with our messaging and warnings in the future to set better expectations for our guests. We also want to let you know we have recently upgraded our internet provider to ensure faster, more reliable speeds for streaming in the evenings. Please feel free to reach out to us directly at [Phone Number] so we can ensure an even better stay next time.'
  }
}

export default function OwnerRezLandingPage() {
  const router = useRouter()

  // Form state
  const [fullName,  setFullName]  = useState('')
  const [email,     setEmail]     = useState('')
  const [password,  setPassword]  = useState('')
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  // Auth state
  const [authed,        setAuthed]        = useState(false)
  const [checkingAuth,  setCheckingAuth]  = useState(true)

  // Sandbox active tab selector
  const [activeTab, setActiveTab] = useState<keyof typeof SANDBOX_SCENARIOS>('glowing')

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
    <div className="min-h-screen" style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif", background: '#102246' }}>

      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 flex items-center justify-between px-8 h-16"
           style={{ background: '#102246', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
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
      <section className="relative overflow-hidden px-8 py-20">
        <div className="absolute inset-0 pointer-events-none"
             style={{
               backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)',
               backgroundSize:  '28px 28px',
             }} />

        <div className="relative mx-auto" style={{ maxWidth: 1100 }}>
          <div className="flex flex-col lg:flex-row items-start gap-16">

            {/* ── Left: Messaging ──────────────────────────────────────── */}
            <div className="flex-1 pt-4">
              <div className="inline-flex items-center gap-2.5 rounded-full px-4 py-1.5 mb-8"
                   style={{ background: 'rgba(252,209,22,0.1)', border: '1px solid rgba(252,209,22,0.3)' }}>
                <span className="font-black text-xs rounded px-1.5 py-0.5 leading-none"
                      style={{ background: '#5BAC43', color: '#fff', letterSpacing: '-0.3px' }}>
                  OR
                </span>
                <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#FCD116' }}>
                  Official OwnerRez Integration Partner
                </span>
              </div>

              <h1 className="font-black leading-[1.06] tracking-tight mb-6"
                  style={{ fontSize: 'clamp(34px, 4.5vw, 52px)', color: '#fff', letterSpacing: '-1.5px', maxWidth: 560 }}>
                The operations layer your <span style={{ color: '#FCD116' }}>OwnerRez account</span> is missing.
              </h1>

              <p className="mb-10 leading-relaxed"
                 style={{ fontSize: 17, color: 'rgba(255,255,255,0.6)', maxWidth: 500 }}>
                FieldStay connects directly to your bookings to automate everything your team handles on the ground—turnover management, offline crew checklists, asset inventory tracking, and field maintenance schedules.
              </p>

              <div className="flex flex-wrap gap-6">
                {[
                  'Free 14-day operations trial',
                  'No credit card required',
                  'Connects in under 5 minutes',
                ].map((signal) => (
                  <div key={signal} className="flex items-center gap-2">
                    <span className="flex items-center justify-center rounded-full font-black text-xs"
                          style={{ width: 18, height: 18, minWidth: 18, background: '#FCD116', color: '#102246', lineHeight: '18px' }}>
                      ✓
                    </span>
                    <span className="text-sm font-medium" style={{ color: 'rgba(255,255,255,0.7)' }}>
                      {signal}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Right: Signup form ────────────────────────────────────── */}
            <div className="w-full lg:w-[400px] flex-shrink-0">
              <div className="rounded-2xl p-8" style={{ background: '#fff', boxShadow: '0 24px 64px rgba(0,0,0,0.3)' }}>
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
                    <div className="inline-flex items-center justify-center rounded-full mb-4" style={{ width: 52, height: 52, background: 'rgba(16,34,70,0.08)' }}>
                      <span className="font-black text-xl" style={{ color: '#102246' }}>✓</span>
                    </div>
                    <h2 className="font-black mb-2 tracking-tight" style={{ fontSize: 20, color: '#111827', letterSpacing: '-0.5px' }}>
                      You&apos;re already signed in
                    </h2>
                    <p className="text-sm mb-7" style={{ color: '#6B7280', lineHeight: 1.6 }}>
                      Click below to link your OwnerRez account and open your FieldStay command dashboard.
                    </p>
                    <a href="/api/integrations/ownerrez/connect"
                       className="block w-full text-center rounded-xl font-bold text-sm py-3.5 transition-opacity hover:opacity-90"
                       style={{ background: '#FCD116', color: '#102246' }}>
                      Connect OwnerRez Account →
                    </a>
                  </div>
                ) : (
                  <>
                    <h2 className="font-black mb-1 tracking-tight" style={{ fontSize: 20, color: '#111827', letterSpacing: '-0.5px' }}>
                      Create your FieldStay account
                    </h2>
                    <p className="text-sm mb-6" style={{ color: '#6B7280' }}>
                      Sync your properties and team in the next step.
                    </p>

                    {error && (
                      <div className="rounded-lg px-4 py-3 mb-5 text-sm" style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C' }}>
                        {error}
                      </div>
                    )}

                    <form onSubmit={handleSignup} className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide" style={{ color: '#374151' }}>Full Name</label>
                        <input type="text" required value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Jane Smith" className="w-full rounded-lg px-4 py-3 text-sm outline-none" style={{ border: '1.5px solid #E5E7EB', color: '#111827' }} />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide" style={{ color: '#374151' }}>Email</label>
                        <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@example.com" className="w-full rounded-lg px-4 py-3 text-sm outline-none" style={{ border: '1.5px solid #E5E7EB', color: '#111827' }} />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide" style={{ color: '#374151' }}>Password</label>
                        <input type="password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" className="w-full rounded-lg px-4 py-3 text-sm outline-none" style={{ border: '1.5px solid #E5E7EB', color: '#111827' }} />
                      </div>
                      <button type="submit" disabled={loading} className="w-full rounded-xl font-bold text-sm py-3.5 mt-2 text-center" style={{ background: loading ? '#E5E7EB' : '#FCD116', color: '#102246', border: 'none', cursor: loading ? 'not-allowed' : 'pointer' }}>
                        {loading ? 'Creating account…' : 'Create Account & Connect OwnerRez →'}
                      </button>
                    </form>
                  </>
                )}
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ── Core Operations Platform Features ───────────────────────────── */}
      <section className="px-8 py-20" style={{ background: '#0c1d3a' }}>
        <div className="mx-auto" style={{ maxWidth: 1100 }}>
          <div className="text-center mb-14">
            <h2 className="font-black tracking-tight mb-3" style={{ fontSize: 'clamp(26px, 3.5vw, 36px)', color: '#fff', letterSpacing: '-1px' }}>
              Everything OwnerRez doesn&apos;t handle on the ground.
            </h2>
            <p className="text-sm" style={{ color: 'rgba(255,255,255,0.45)' }}>
              Built specifically for tactical field operations, turnover coordination, and asset tracking.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {CORE_FEATURES.map((f) => (
              <div key={f.number} className="rounded-2xl p-7" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="font-black mb-4 leading-none" style={{ fontSize: 36, color: 'rgba(252,209,22,0.2)', letterSpacing: '-2px' }}>
                  {f.number}
                </div>
                <p className="font-bold mb-3" style={{ fontSize: 16, color: '#fff' }}>{f.title}</p>
                <p className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)' }}>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Optional Add-On Feature: RepuGuard ──────────────────────────── */}
      <section className="px-8 py-20" style={{ background: '#102246', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <div className="mx-auto" style={{ maxWidth: 900 }}>
          <div className="text-center mb-12">
            <span className="text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full" style={{ background: 'rgba(91,172,67,0.1)', color: '#5BAC43' }}>
              Exclusive Optional Module
            </span>
            <h2 className="font-black tracking-tight mt-3 mb-4" style={{ fontSize: 32, color: '#fff', letterSpacing: '-1px' }}>
              Add-On: RepuGuard Reputation Engine
            </h2>
            <p className="text-sm mx-auto" style={{ color: 'rgba(255,255,255,0.6)', maxWidth: 580 }}>
              Need help managing your reviews? Toggle on the optional RepuGuard module. It generates context-perfect, non-defensive guest responses on auto-pilot. 
              <span className="block mt-2 font-semibold text-white">Year 1 Partner Special: 3 Months Free, then just $15/mo (Standard $29/mo).</span>
            </p>
          </div>

          {/* Sandbox Controls */}
          <div className="flex justify-center gap-3 mb-8">
            {(Object.keys(SANDBOX_SCENARIOS) as Array<keyof typeof SANDBOX_SCENARIOS>).map((key) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className="px-4 py-2 rounded-lg text-xs font-bold transition-all"
                style={{
                  background: activeTab === key ? '#FCD116' : 'rgba(255,255,255,0.05)',
                  color: activeTab === key ? '#102246' : 'rgba(255,255,255,0.7)',
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                {SANDBOX_SCENARIOS[key].label}
              </button>
            ))}
          </div>

          {/* Sandbox Visual Layout Box */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 rounded-2xl p-6" style={{ background: '#0c1d3a', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div>
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.4)' }}>
                Incoming Guest Review
              </span>
              <p className="text-xs font-semibold mt-1 mb-3" style={{ color: '#FCD116' }}>
                {SANDBOX_SCENARIOS[activeTab].guest}
              </p>
              <div className="rounded-xl p-4 text-sm italic leading-relaxed" style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.85)' }}>
                {SANDBOX_SCENARIOS[activeTab].text}
              </div>
            </div>

            <div style={{ borderLeft: '1px solid rgba(255,255,255,0.05)', paddingLeft: '1rem' }}>
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.4)' }}>
                RepuGuard Smart Output
              </span>
              <p className="text-xs font-semibold mt-1 mb-3" style={{ color: '#5BAC43' }}>
                ✓ Context Anchor Rule Applied
              </p>
              <div className="rounded-xl p-4 text-sm leading-relaxed" style={{ background: 'rgba(16,34,70,0.4)', color: '#fff', border: '1px solid rgba(252,209,22,0.1)' }}>
                {SANDBOX_SCENARIOS[activeTab].reply}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Bottom CTA ──────────────────────────────────────────────────── */}
      <section className="px-8 py-16 text-center" style={{ background: '#F8F9FA', borderTop: '1px solid #E5E7EB' }}>
        <p className="font-black mb-1 tracking-tight" style={{ fontSize: 'clamp(22px, 3vw, 30px)', color: '#102246', letterSpacing: '-0.75px' }}>
          Streamline Your Field Operations
        </p>
        <p className="text-sm mb-7" style={{ color: '#6B7280' }}>
          Get started with a 14-day free trial of our core features. Optional RepuGuard bundle available inside.
        </p>
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="inline-block rounded-xl font-bold text-sm px-8 py-3.5 transition-opacity hover:opacity-90"
          style={{ background: '#102246', color: '#FCD116', border: 'none', cursor: 'pointer' }}
        >
          Start Your Free Trial →
        </button>
      </section>

    </div>
  )
}
