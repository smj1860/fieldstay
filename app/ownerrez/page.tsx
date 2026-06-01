'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// ── How It Works Steps ─────────────────────────────────────────────────────
const STEPS = [
  {
    number: '1',
    title: 'Connect OwnerRez',
    desc: 'Authorize FieldStay with a single click. We instantly pull your properties, teams, and booking calendar into your new operational hub.'
  },
  {
    number: '2',
    title: 'Deploy the Field Ops Layer',
    desc: 'Your team gets automated offline checklists, live inventory par levels, and maintenance schedules triggered entirely by incoming reservations.'
  },
  {
    number: '3',
    title: 'Toggle RepuGuard',
    desc: 'Optionally activate the reputation engine. Watch 4 and 5-star responses stream on autopilot while critical feedback routes safely to your private queue.'
  }
]

// ── Expanded Sandbox Demo Dataset (RepuGuard Optional Module) ───────────────
const SANDBOX_SCENARIOS = {
  fiveStar: {
    label: '5-Star Response',
    badge: '✓ Context Anchor Rule Applied',
    badgeColor: '#5BAC43',
    guest: 'David • The Lakehouse',
    text: '"Absolutely incredible stay! The back deck views at sunset were breathtaking. We spent every night out there. Also, a huge shoutout to Sarah who helped us coordinate an early check-in so our toddler could nap. Clean, spacious, and perfect."',
    reply: 'Hi David, thank you so much for the wonderful review! We\'re thrilled you got to experience those breathtaking sunset views from the back deck—they really are the best part of the property. I\'ll be sure to pass your kind words along to Sarah; she loves going above and beyond to make sure families have a smooth check-in. We would love to host your family again for another lakeside getaway soon!'
  },
  fourStar: {
    label: '4-Star Response',
    badge: '✓ Professional Polish Rule Applied',
    badgeColor: '#5BAC43',
    guest: 'Emily • Downtown Loft',
    text: '"Great location, super stylish, and walking distance to everything. The bed was incredibly comfortable. Only giving 4 stars because we couldn\'t find the remote for the living room TV and the coffee pods ran out on day two."',
    reply: 'Hi Emily, thank you for staying with us and for highlighting the stylish space and comfortable bed! We are so glad our downtown location worked out perfectly for your walks. I do apologize for the frustration with the living room remote and the coffee shortage. We want every guest to have a flawless experience, so we\'ve already tracked down that remote and stocked the closet with extra coffee pods for future stays. If you ever head back this way, please reach out directly—we\'d love the chance to welcome you back for a perfect stay.'
  },
  threeStar: {
    label: '3-Star Response',
    badge: '✓ Operational Pivot Rule Applied',
    badgeColor: '#FCD116',
    guest: 'Marcus • Mountain Cabin',
    text: '"The cabin itself is beautiful and the hot tub was clean. However, the gravel driveway is incredibly steep and our sedan struggled to get up it. Also, the WiFi was too slow to stream movies in the evening."',
    reply: 'Hi Marcus, thank you for taking the time to share your feedback. We are glad you found the cabin beautiful and enjoyed the hot tub. Thank you for letting us know how your sedan handled the gravel driveway; that will help us with our messaging and warnings in the future to set better expectations for our guests. We also want to let you know we have recently upgraded our internet provider to ensure faster, more reliable speeds for streaming in the evenings. Please feel free to reach out to us directly so we can ensure an even better stay next time.'
  },
  oneStar: {
    label: '1-Star Response',
    badge: '⚠️ Mitigation & Escalation Flag Triggered',
    badgeColor: '#EF4444',
    guest: 'Robert • Creekside Villa',
    text: '"An absolute disaster. We arrived in mid-July and the air conditioner was completely broken. The house was 85 degrees inside. We had to sit around sweating for hours waiting for someone to respond to our texts."',
    reply: 'Hi Robert, I am deeply sorry for the severe frustration and discomfort caused by the air conditioning malfunction during your arrival. We completely understand how upsetting it is to walk into an 85-degree house in mid-July. To ensure accurate billing adjustments and a direct resolution regarding this breakdown, please contact our management team directly at [Phone Number] or [Email Address] so we can make this right.'
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
  const [activeTab, setActiveTab] = useState<keyof typeof SANDBOX_SCENARIOS>('fiveStar')

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

      {/* ── Split Hero Value Propositions ───────────────────────────────── */}
      <section className="relative overflow-hidden px-8 pt-20 pb-12">
        <div className="absolute inset-0 pointer-events-none"
             style={{
               backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)',
               backgroundSize:  '28px 28px',
             }} />

        <div className="relative mx-auto" style={{ maxWidth: 1100 }}>
          
          {/* Partnership eyebrow */}
          <div className="inline-flex items-center gap-2.5 rounded-full px-4 py-1.5 mb-10"
               style={{ background: 'rgba(252,209,22,0.1)', border: '1px solid rgba(252,209,22,0.3)' }}>
            <span className="font-black text-xs rounded px-1.5 py-0.5 leading-none"
                  style={{ background: '#5BAC43', color: '#fff', letterSpacing: '-0.3px' }}>
              OR
            </span>
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#FCD116' }}>
              Official OwnerRez Integration Ecosystem Partner
            </span>
          </div>

          {/* Two Halves Layout Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-start">
            
            {/* Left Half: The Main Operations Product */}
            <div style={{ borderRight: '1px solid rgba(255,255,255,0.08)', paddingRight: '1.5rem' }}>
              <h1 className="font-black leading-[1.06] tracking-tight mb-6"
                  style={{ fontSize: 'clamp(30px, 4vw, 44px)', color: '#fff', letterSpacing: '-1.5px' }}>
                The operations layer your <span style={{ color: '#FCD116' }}>OwnerRez account</span> is missing.
              </h1>
              <p className="leading-relaxed text-sm lg:text-base" style={{ color: 'rgba(255,255,255,0.65)' }}>
                FieldStay connects directly to your bookings to automate everything your team handles on the ground—fully operational offline turnover management, crew checklists, asset inventory tracking with par levels, and field maintenance schedules and work orders.
              </p>
            </div>

            {/* Right Half: The Exclusive Add-On Module */}
            <div>
              <h2 className="font-black leading-[1.06] tracking-tight mb-6"
                  style={{ fontSize: 'clamp(30px, 4vw, 44px)', color: '#fff', letterSpacing: '-1.5px' }}>
                Exclusively available to OwnerRez users only is our <span style={{ color: '#5BAC43' }}>RepuGuard Engine</span>
              </h2>
              <p className="leading-relaxed text-sm lg:text-base" style={{ color: 'rgba(255,255,255,0.65)' }}>
                Need help managing your reviews? Toggle on the optional RepuGuard module. It generates context-perfect, non-defensive guest responses on auto-pilot. Now until the end of the year all OwnerRez users receive RepuGuard for 3 Months Free and exclusive pricing of just $15/mo for life after trial (Standard $29/mo).
              </p>
            </div>

          </div>
        </div>
      </section>

      {/* ── Central Sign-Up Component Area ──────────────────────────────── */}
      <section className="px-8 pb-20">
        <div className="mx-auto" style={{ maxWidth: 500 }}>
          <div className="rounded-2xl p-8" style={{ background: '#fff', boxShadow: '0 24px 64px rgba(0,0,0,0.3)' }}>
            
            {checkingAuth ? (
              <div className="space-y-3 animate-pulse">
                <div className="h-5 rounded" style={{ background: '#F3F4F6', width: '60%' }} />
                <div className="h-4 rounded" style={{ background: '#F3F4F6', width: '80%' }} />
                <div className="h-11 rounded-lg mt-6" style={{ background: '#F3F4F6' }} />
                <div className="h-11 rounded-lg" style={{ background: '#F3F4F6' }} />
                <div className="h-12 rounded-lg mt-2" style={{ background: '#F3F4F6' }} />
              </div>
            ) : authed ? (
              <div className="text-center">
                <div className="inline-flex items-center justify-center rounded-full mb-4" style={{ width: 52, height: 52, background: 'rgba(16,34,70,0.08)' }}>
                  <span className="font-black text-xl" style={{ color: '#102246' }}>✓</span>
                </div>
                <h2 className="font-black mb-2 tracking-tight" style={{ fontSize: 20, color: '#111827', letterSpacing: '-0.5px' }}>
                  Ready to access your account?
                </h2>
                <p className="text-sm mb-7" style={{ color: '#6B7280', lineHeight: 1.6 }}>
                  Click below to link your database properties and sync your ground crew dashboard.
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
                  Includes 14-day operations trial · Secure your $15/mo lifetime add-on rate.
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
      </section>

      {/* ── How It Works Section ────────────────────────────────────────── */}
      <section className="px-8 py-20" style={{ background: '#0c1d3a', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <div className="mx-auto" style={{ maxWidth: 1100 }}>
          <div className="text-center mb-16">
            <h2 className="font-black tracking-tight text-white mb-4" style={{ fontSize: 32, letterSpacing: '-1px' }}>
              How It Works
            </h2>
            <p className="text-sm mx-auto" style={{ color: 'rgba(255,255,255,0.5)', maxWidth: 450 }}>
              Three steps to bring enterprise-level automated tracking to your short-term rental management.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {STEPS.map((step) => (
              <div key={step.number} className="relative p-6 rounded-2xl" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="absolute -top-5 left-6 w-10 h-10 rounded-xl font-black text-sm flex items-center justify-center" style={{ background: '#FCD116', color: '#102246' }}>
                  {step.number}
                </div>
                <h3 className="font-bold text-white text-base mt-4 mb-2">{step.title}</h3>
                <p className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)' }}>{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Expanded 4-Tier Interactive Sandbox ─────────────────────────── */}
      <section className="px-8 py-20" style={{ background: '#102246', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <div className="mx-auto" style={{ maxWidth: 950 }}>
          <div className="text-center mb-12">
            <span className="text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full" style={{ background: 'rgba(91,172,67,0.1)', color: '#5BAC43' }}>
              RepuGuard Deep Dive Preview
            </span>
            <h2 className="font-black tracking-tight text-white mt-3 mb-4" style={{ fontSize: 32, letterSpacing: '-1px' }}>
              Explore the Full Spectrum Response Guard
            </h2>
            <p className="text-sm mx-auto" style={{ color: 'rgba(255,255,255,0.6)', maxWidth: 600 }}>
              Click through the star counts below to see how our targeted prompt rules adapt tone dynamically—protecting operational boundaries while remaining completely non-defensive.
            </p>
          </div>

          {/* Expanded Horizontal Star Selector Buttons */}
          <div className="grid grid-cols-2 sm:flex sm:justify-center gap-3 mb-8">
            {(Object.keys(SANDBOX_SCENARIOS) as Array<keyof typeof SANDBOX_SCENARIOS>).map((key) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className="px-4 py-2.5 rounded-lg text-xs font-bold transition-all text-center"
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

          {/* Interactive Split Window Showcase */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 rounded-2xl p-6" style={{ background: '#0c1d3a', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div>
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.4)' }}>
                Incoming Guest Feedback
              </span>
              <p className="text-xs font-semibold mt-1 mb-3" style={{ color: '#FCD116' }}>
                {SANDBOX_SCENARIOS[activeTab].guest}
              </p>
              <div className="rounded-xl p-4 text-sm italic leading-relaxed" style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.85)' }}>
                {SANDBOX_SCENARIOS[activeTab].text}
              </div>
            </div>

            <div className="md:border-l" style={{ borderColor: 'rgba(255,255,255,0.05)', mdPaddingLeft: '1rem' }}>
              <span className="text-xs font-bold uppercase tracking-wider block md:pl-4" style={{ color: 'rgba(255,255,255,0.4)' }}>
                Automated System Analysis
              </span>
              <p className="text-xs font-semibold mt-1 mb-3 md:pl-4" style={{ color: SANDBOX_SCENARIOS[activeTab].badgeColor }}>
                {SANDBOX_SCENARIOS[activeTab].badge}
              </p>
              <div className="rounded-xl p-4 text-sm leading-relaxed md:ml-4" style={{ background: 'rgba(16,34,70,0.4)', color: '#fff', border: '1px solid rgba(252,209,22,0.1)' }}>
                {SANDBOX_SCENARIOS[activeTab].reply}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Bottom CTA ──────────────────────────────────────────────────── */}
      <section className="px-8 py-16 text-center" style={{ background: '#F8F9FA', borderTop: '1px solid #E5E7EB' }}>
        <p className="font-black mb-1 tracking-tight" style={{ fontSize: 'clamp(22px, 3vw, 30px)', color: '#102246', letterSpacing: '-0.75px' }}>
          Deploy Better Guardrails For Your Business
        </p>
        <p className="text-sm mb-7" style={{ color: '#6B7280' }}>
          Start your 14-day free operations trial. Lock in the RepuGuard partner bundle before the deadline.
        </p>
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="inline-block rounded-xl font-bold text-sm px-8 py-3.5 transition-opacity hover:opacity-90"
          style={{ background: '#102246', color: '#FCD116', border: 'none', cursor: 'pointer' }}
        >
          Start Onboarding Securely →
        </button>
      </section>

    </div>
  )
}
