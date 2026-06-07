'use client'

import { useState } from 'react'
import Link from 'next/link'

export default function LandingPage() {
  const [annual, setAnnual] = useState(false)

  return (
    <div className="min-h-screen" style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif" }}>

      {/* ── Nav ──────────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 flex items-center justify-between px-8 h-16"
           style={{ background: '#102246' }}>
        <span className="text-xl font-black tracking-tight" style={{ color: '#fff' }}>
          Field<span style={{ color: '#FCD116' }}>Stay</span>
        </span>
        <div className="flex items-center gap-2">
          <Link href="/login"
                className="text-sm px-4 py-2 rounded-md transition-colors"
                style={{ color: 'rgba(255,255,255,0.65)' }}
                onMouseOver={e => (e.currentTarget.style.color = '#fff')}
                onMouseOut={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.65)')}>
            Log In
          </Link>
          <Link href="/signup"
                className="text-sm font-bold px-4 py-2 rounded-md transition-opacity"
                style={{ background: '#FCD116', color: '#102246' }}>
            Start Free Trial
          </Link>
        </div>
      </nav>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden text-center px-8 py-24"
               style={{ background: '#102246' }}>
        {/* Dot grid texture */}
        <div className="absolute inset-0 pointer-events-none"
             style={{
               backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)',
               backgroundSize: '28px 28px',
             }} />

        {/* Eyebrow */}
        <div className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-bold
                        uppercase tracking-widest mb-7"
             style={{ background: 'rgba(252,209,22,0.12)', border: '1px solid rgba(252,209,22,0.25)', color: '#FCD116' }}>
          Built for STR Property Managers
        </div>

        {/* Headline */}
        <h1 className="mx-auto mb-5 font-black leading-[1.08] tracking-tight"
            style={{ fontSize: 'clamp(36px, 5vw, 54px)', color: '#fff', maxWidth: 720, letterSpacing: '-1.5px' }}>
          Stop Running Your Properties on{' '}
          <span style={{ color: '#FCD116' }}>Texts & Spreadsheets.</span>
        </h1>

        {/* Subhead */}
        <p className="mx-auto mb-9" style={{ fontSize: 18, color: 'rgba(255,255,255,0.62)', maxWidth: 560, lineHeight: 1.65 }}>
          FieldStay coordinates your turnovers, inventory, maintenance, and owner
          reporting in one platform — with a true offline app your cleaning crew
          can use anywhere at the property.
        </p>

        {/* CTA */}
        <Link href="/signup"
              className="inline-flex items-center gap-2 rounded-lg font-black text-base transition-all"
              style={{ background: '#FCD116', color: '#102246', padding: '16px 36px' }}>
          Start Free Trial <span style={{ fontSize: 20 }}>→</span>
        </Link>
        <p className="mt-4 text-sm" style={{ color: 'rgba(255,255,255,0.38)' }}>
          14-day free trial · No credit card required · Cancel anytime
        </p>
      </section>

      {/* ── Stats bar ────────────────────────────────────────────────────── */}
      <div className="flex justify-center gap-16 px-8 py-5"
           style={{ background: '#0d1e3d', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {[
          { num: '15 min', label: 'Avg. property setup' },
          { num: '0',      label: 'Spreadsheets needed' },
          { num: '100%',   label: 'Offline crew access' },
        ].map((s) => (
          <div key={s.label} className="text-center">
            <div className="font-black leading-none mb-1"
                 style={{ fontSize: 28, color: '#FCD116', letterSpacing: '-1px' }}>
              {s.num}
            </div>
            <div className="text-xs font-bold uppercase tracking-wider"
                 style={{ color: 'rgba(255,255,255,0.45)' }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>

      {/* ── Pain section ─────────────────────────────────────────────────── */}
      <section className="px-8 py-20" style={{ background: '#F8F9FA' }}>
        <div className="mx-auto" style={{ maxWidth: 900 }}>
          <p className="text-xs font-bold uppercase tracking-widest mb-3"
             style={{ color: '#102246' }}>
            Sound familiar?
          </p>
          <h2 className="font-black mb-2 tracking-tight"
              style={{ fontSize: 'clamp(28px, 4vw, 38px)', color: '#102246', letterSpacing: '-1px' }}>
            Managing properties today is chaotic.
          </h2>
          <p className="mb-10 text-base" style={{ color: '#6B7280' }}>
            If any of these describe your week, FieldStay was built for you.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              {
                icon: '💬',
                title: 'Coordinating cleaners over group text',
                body: 'Scrolling back through 40 messages trying to figure out if someone confirmed Saturday\'s checkout.',
              },
              {
                icon: '📦',
                title: 'Finding out you\'re out of supplies at 9pm',
                body: 'Crew texts you mid-turnover that there\'s no laundry pods. Next guests check in tomorrow at 3pm.',
              },
              {
                icon: '🔧',
                title: 'Chasing vendors for work order updates',
                body: 'You submitted the repair request two weeks ago. Still no idea if anyone has looked at it.',
              },
              {
                icon: '📊',
                title: 'Copy-pasting P&Ls to owners every month',
                body: 'Manually pulling numbers from your booking platform and pasting them into a spreadsheet to email out.',
              },
            ].map((item) => (
              <div key={item.title}
                   className="flex items-start gap-4 rounded-xl p-5"
                   style={{ background: '#fff', border: '1px solid #E5E7EB' }}>
                <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-lg"
                     style={{ background: '#FFF8E7' }}>
                  {item.icon}
                </div>
                <div>
                  <p className="font-bold text-sm mb-1" style={{ color: '#111827' }}>{item.title}</p>
                  <p className="text-sm leading-relaxed" style={{ color: '#6B7280' }}>{item.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <section className="px-8 py-20" style={{ background: '#fff' }}>
        <div className="mx-auto" style={{ maxWidth: 960 }}>
          <div className="text-center mb-14">
            <h2 className="font-black mb-3 tracking-tight"
                style={{ fontSize: 'clamp(28px, 4vw, 38px)', color: '#102246', letterSpacing: '-1px' }}>
              Everything between check-out and check-in.
            </h2>
            <p className="text-base mx-auto" style={{ color: '#6B7280', maxWidth: 480 }}>
              FieldStay handles operations so you can focus on growing your portfolio.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              {
                tag: 'Turnovers',
                title: 'Automated from your calendar',
                body: 'Connect your Airbnb or VRBO iCal. FieldStay reads your bookings, generates turnovers in the gaps, and assigns them to crew — with mandatory photo proof on any task that needs it.',
                details: [
                  'Auto-generated from booking gaps',
                  'Crew notified immediately on assignment',
                  'Photo capture blocks completion when required',
                  'True offline access — no Wi-Fi required on-site',
                ],
              },
              {
                tag: 'Inventory',
                title: 'Par levels that reorder themselves',
                body: 'Set par levels for every item at every property. When crew submits their count and something\'s below par, a purchase order emails you automatically. You just place the order.',
                details: [
                  'Pre-seeded catalog of common STR supplies',
                  'Per-property par level configuration',
                  'Crew submits counts offline via mobile app',
                  'Auto-generated PO when stock is low',
                ],
              },
              {
                tag: 'Maintenance',
                title: 'Work orders vendors actually complete',
                body: 'Create work orders and assign vendors. Vendors get a tokenized link — no account needed — to mark work complete, attach photos, and add notes. You\'re notified instantly.',
                details: [
                  'Vendor portal requires zero login to use',
                  'Routine and seasonal schedule tracking',
                  'Auto-create work orders from due schedules',
                  'Maintenance costs flow into owner P&L',
                ],
              },
              {
                tag: 'Owner P&L',
                title: 'P&L your owners can actually see',
                body: 'Revenue auto-calculates from synced bookings. Maintenance costs flow in from completed work orders. Owners click a link and see their numbers — no password, no account needed.',
                details: [
                  'Revenue auto-pulled from booking data',
                  'Expenses auto-created from work order costs',
                  'Monthly P&L with category breakdown',
                  'Tokenized portal — owners click link, done',
                ],
              },
            ].map((f) => (
              <div key={f.tag}
                   className="rounded-2xl p-7 relative overflow-hidden transition-all"
                   style={{ border: '1px solid #E5E7EB' }}>
                <div className="absolute top-0 left-0 right-0 h-[3px] rounded-t-2xl"
                     style={{ background: '#102246' }} />
                <span className="inline-block rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest mb-4"
                      style={{ background: '#EEF2FF', color: '#102246' }}>
                  {f.tag}
                </span>
                <h3 className="font-black mb-3 tracking-tight"
                    style={{ fontSize: 20, color: '#111827', letterSpacing: '-0.3px' }}>
                  {f.title}
                </h3>
                <p className="text-sm leading-relaxed mb-5" style={{ color: '#6B7280' }}>
                  {f.body}
                </p>
                <div className="flex flex-col gap-2">
                  {f.details.map((d) => (
                    <div key={d} className="flex items-center gap-2.5 text-sm" style={{ color: '#374151' }}>
                      <span className="flex-shrink-0 flex items-center justify-center rounded-full text-xs font-black"
                            style={{ width: 18, height: 18, background: '#102246', color: '#FCD116', lineHeight: '18px' }}>
                        ✓
                      </span>
                      {d}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section className="px-8 py-20 text-center" style={{ background: '#102246' }}>
        <div className="mx-auto" style={{ maxWidth: 800 }}>
          <h2 className="font-black mb-3 tracking-tight"
              style={{ fontSize: 'clamp(28px, 4vw, 38px)', color: '#fff', letterSpacing: '-1px' }}>
            Up and running in minutes.
          </h2>
          <p className="mb-14 text-base" style={{ color: 'rgba(255,255,255,0.5)' }}>
            No implementation fees. No onboarding call required.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 text-left">
            {[
              {
                n: '01',
                title: 'Add your properties',
                desc: 'Name, address, check-in times, door codes, Wi-Fi details — and paste your Airbnb or VRBO iCal URL. Bookings sync automatically.',
              },
              {
                n: '02',
                title: 'Configure the details',
                desc: 'Set inventory par levels, build your cleaning checklist, add maintenance schedules, invite your crew. Takes about 15 minutes per property.',
              },
              {
                n: '03',
                title: 'Run on autopilot',
                desc: 'Turnovers generate, crew works offline, purchase orders send themselves, owners see their P&L. You manage exceptions, not logistics.',
              },
            ].map((step) => (
              <div key={step.n}
                   className="rounded-2xl p-7"
                   style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}>
                <div className="font-black mb-3 leading-none"
                     style={{ fontSize: 40, color: 'rgba(252,209,22,0.2)', letterSpacing: '-2px' }}>
                  {step.n}
                </div>
                <p className="font-bold mb-2" style={{ fontSize: 17, color: '#fff' }}>{step.title}</p>
                <p className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      <section className="px-8 py-20" style={{ background: '#F8F9FA' }}>
        <div className="mx-auto" style={{ maxWidth: 900 }}>
          <div className="text-center mb-10">
            <h2 className="font-black mb-2 tracking-tight"
                style={{ fontSize: 'clamp(28px, 4vw, 38px)', color: '#102246', letterSpacing: '-1px' }}>
              Simple, transparent pricing.
            </h2>
            <p className="text-sm" style={{ color: '#6B7280' }}>
              Full software on every plan. No features gated by tier.
            </p>
          </div>

          {/* Billing toggle */}
          <div className="flex items-center justify-center gap-3 mb-9">
            <span className="text-sm font-bold"
                  style={{ color: annual ? '#9CA3AF' : '#102246' }}>
              Monthly
            </span>
            <button
              onClick={() => setAnnual(!annual)}
              className="relative rounded-full transition-colors"
              style={{ width: 48, height: 26, background: '#102246', border: 'none', cursor: 'pointer' }}
            >
              <span className="absolute top-[3px] rounded-full transition-transform"
                    style={{
                      width: 20, height: 20,
                      background: '#FCD116',
                      left: 3,
                      transform: annual ? 'translateX(22px)' : 'translateX(0)',
                      display: 'block',
                      transition: 'transform 0.2s',
                    }} />
            </button>
            <span className="text-sm font-bold flex items-center gap-2"
                  style={{ color: annual ? '#102246' : '#9CA3AF' }}>
              Annual
              <span className="rounded-full px-2 py-0.5 text-xs font-black"
                    style={{ background: '#FCD116', color: '#102246' }}>
                Save 2 months
              </span>
            </span>
          </div>

          {/* Plan cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {[
              {
                name: 'Starter',
                description: 'For independent managers with a focused portfolio.',
                props: 'Up to 15 properties',
                monthly: 199, annual: 1990,
                highlight: false,
                features: [
                  'iCal sync (Airbnb, VRBO)',
                  'Turnover board + crew app',
                  'Offline checklist + photo capture',
                  'Inventory with auto purchase orders',
                  'Maintenance + vendor portal',
                  'Owner P&L portal',
                  'Crew email invites',
                ],
                cta: 'Start Free Trial',
                ctaHref: '/signup',
              },
              {
                name: 'Growth',
                description: 'For expanding operations that need more scale.',
                props: '16–50 properties',
                monthly: 379, annual: 3790,
                highlight: true,
                badge: 'Most Popular',
                features: [
                  'Everything in Starter',
                  'Up to 50 properties',
                  'Priority support',
                ],
                cta: 'Start Free Trial',
                ctaHref: '/signup',
              },
              {
                name: 'Portfolio',
                description: 'For professional managers running a full operation.',
                props: '51–100 properties',
                monthly: 599, annual: 5990,
                highlight: false,
                features: [
                  'Everything in Growth',
                  'Up to 100 properties',
                  'Custom onboarding',
                  'Dedicated account support',
                ],
                cta: 'Start Free Trial',
                ctaHref: '/signup',
              },
              {
                name: 'Enterprise',
                description: 'For large portfolios and multi-location operations.',
                props: '100+ properties',
                monthly: null, annual: null,
                highlight: false,
                features: [
                  'Everything in Portfolio',
                  'Unlimited properties',
                  'SLA-backed uptime',
                  'Volume pricing',
                ],
                cta: 'Contact Us',
                ctaHref: 'mailto:hello@fieldstay.app',
              },
            ].map((plan) => (
              <div key={plan.name}
                   className="rounded-2xl p-7 flex flex-col"
                   style={{
                     background: '#fff',
                     border: plan.highlight ? '2px solid #102246' : '1.5px solid #E5E7EB',
                     boxShadow: plan.highlight ? '0 0 0 4px rgba(16,34,70,0.07)' : 'none',
                   }}>
                {plan.badge && (
                  <span className="self-start rounded-full px-3 py-1 text-xs font-black uppercase tracking-wider mb-4"
                        style={{ background: '#FCD116', color: '#102246' }}>
                    {plan.badge}
                  </span>
                )}
                <p className="font-black mb-1" style={{ fontSize: 18, color: '#111827' }}>
                  {plan.name}
                </p>
                <p className="text-xs mb-1" style={{ color: '#6B7280' }}>{plan.description}</p>
                <p className="text-sm mb-5" style={{ color: '#9CA3AF' }}>{plan.props}</p>

                {/* Price */}
                <div className="mb-5">
                  {plan.monthly !== null ? (
                    <>
                      <span className="font-black tracking-tight"
                            style={{ fontSize: 42, color: '#102246', letterSpacing: '-2px', lineHeight: 1 }}>
                        {annual ? `$${plan.annual!.toLocaleString()}` : `$${plan.monthly}`}
                      </span>
                      <span className="text-sm ml-1" style={{ color: '#9CA3AF' }}>
                        {annual ? '/yr' : '/mo'}
                      </span>
                      {!annual && (
                        <p className="text-xs mt-1" style={{ color: '#9CA3AF' }}>
                          or ${plan.annual!.toLocaleString()}/yr — save ${(plan.monthly! * 12 - plan.annual!)} 
                        </p>
                      )}
                    </>
                  ) : (
                    <span className="font-black" style={{ fontSize: 34, color: '#102246', letterSpacing: '-1px' }}>
                      Custom
                    </span>
                  )}
                </div>

                <div className="mb-5" style={{ height: 1, background: '#F3F4F6' }} />

                <div className="flex flex-col gap-2.5 flex-1 mb-6">
                  {plan.features.map((f) => (
                    <div key={f} className="flex items-start gap-2 text-sm" style={{ color: '#374151' }}>
                      <span className="flex-shrink-0 flex items-center justify-center rounded-full text-xs font-black mt-0.5"
                            style={{ width: 18, height: 18, minWidth: 18, background: '#102246', color: '#FCD116', lineHeight: '18px' }}>
                        ✓
                      </span>
                      {f}
                    </div>
                  ))}
                </div>

                <Link href={plan.ctaHref}
                      className="block text-center rounded-lg font-bold text-sm py-3 transition-opacity"
                      style={{
                        background: plan.highlight ? '#FCD116' : plan.monthly === null ? 'transparent' : '#102246',
                        color: plan.highlight ? '#102246' : plan.monthly === null ? '#102246' : '#fff',
                        border: plan.monthly === null ? '1.5px solid #E5E7EB' : 'none',
                      }}>
                  {plan.cta}
                </Link>
              </div>
            ))}
          </div>

          <p className="text-center text-xs mt-6" style={{ color: '#9CA3AF' }}>
            All plans include a 14-day free trial. No credit card required. Annual billing saves approximately 2 months.
          </p>
        </div>
      </section>

      {/* ── Bottom CTA ───────────────────────────────────────────────────── */}
      <section className="px-8 py-20 text-center" style={{ background: '#FCD116' }}>
        <h2 className="font-black mb-3 tracking-tight"
            style={{ fontSize: 'clamp(28px, 4vw, 38px)', color: '#102246', letterSpacing: '-1px' }}>
          Ready to stop firefighting?
        </h2>
        <p className="text-base mb-9 mx-auto" style={{ color: 'rgba(16,34,70,0.62)', maxWidth: 440 }}>
          Join property managers who replaced their texts and spreadsheets with one platform that actually works.
        </p>
        <Link href="/signup"
              className="inline-flex items-center gap-2 rounded-lg font-black text-base transition-opacity"
              style={{ background: '#102246', color: '#fff', padding: '16px 36px' }}>
          Start Free — 14 Days Free <span style={{ fontSize: 20 }}>→</span>
        </Link>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="flex items-center justify-between px-8 py-7"
              style={{ background: '#0d1e3d' }}>
        <span className="font-black text-base" style={{ color: '#fff' }}>
          Field<span style={{ color: '#FCD116' }}>Stay</span>
        </span>
        <div className="flex items-center gap-6">
          {[
            { label: 'hello@fieldstay.app', href: 'mailto:hello@fieldstay.app' },
            { label: 'Log In', href: '/login' },
            { label: 'Sign Up', href: '/signup' },
          ].map((l) => (
            <Link key={l.label} href={l.href}
                  className="text-sm transition-colors"
                  style={{ color: 'rgba(255,255,255,0.4)' }}>
              {l.label}
            </Link>
          ))}
        </div>
      </footer>

    </div>
  )
}
