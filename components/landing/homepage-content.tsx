'use client'

import { useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { MessageSquare, Package, Wrench, BarChart3, Check } from 'lucide-react'

export function HomepageContent() {
  const [annual, setAnnual] = useState(false)

  return (
    <div className="min-h-screen">

      {/* ── Nav ──────────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 flex items-center justify-between px-8 h-16 bg-brand-800">
        <span className="font-display text-xl font-bold tracking-tight text-white">
          Field<span className="text-gold-300">Stay</span>
        </span>
        <div className="flex items-center gap-2">
          <Link href="/login"
                className="homepage-link text-sm px-4 py-2 rounded-md">
            Log In
          </Link>
          <Link href="/signup"
                className="text-sm font-bold px-4 py-2 rounded-md transition-opacity bg-gold-300 text-brand-800">
            Start Free Trial
          </Link>
        </div>
      </nav>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden text-center px-8 py-24 bg-brand-800">
        {/* Dot grid texture */}
        <div className="absolute inset-0 pointer-events-none"
             style={{
               backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)',
               backgroundSize: '28px 28px',
             }} />

        {/* Eyebrow */}
        <div className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-bold
                        uppercase tracking-widest mb-7 bg-gold-300/12 border border-gold-300/25 text-gold-300">
          Built for STR Property Managers
        </div>

        {/* Headline */}
        <h1 className="font-display mx-auto mb-5 font-bold leading-[1.08] tracking-tight text-white"
            style={{ fontSize: 'clamp(36px, 5vw, 54px)', maxWidth: 720, letterSpacing: '-1.5px' }}>
          Built for the work that happens{' '}
          <span className="text-gold-300">between checkouts.</span>
        </h1>

        {/* Subhead */}
        <p className="mx-auto mb-9 text-white/62" style={{ fontSize: 18, maxWidth: 580, lineHeight: 1.65 }}>
          FieldStay handles crew scheduling, turnovers, maintenance, inventory,
          vendor work orders, and guest communications — so the gap between
          checkout and check-in runs itself.
        </p>

        {/* CTA */}
        <Link href="/signup"
              className="inline-flex items-center gap-2 rounded-lg font-black text-base transition-all bg-gold-300 text-brand-800"
              style={{ padding: '16px 36px' }}>
          Start Free Trial <span style={{ fontSize: 20 }}>→</span>
        </Link>
        <p className="mt-4 text-sm text-white/38">
          14-day free trial · No credit card required · Cancel anytime
        </p>
      </section>

      {/* ── Stats bar ────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row justify-center gap-6 sm:gap-16 px-8 py-6 sm:py-5 bg-brand-900 border-b border-white/6">
        {[
          { num: '15 min', label: 'Avg. property setup' },
          { num: '0',      label: 'Spreadsheets needed' },
          { num: '100%',   label: 'Offline crew access' },
        ].map((s) => (
          <div key={s.label} className="text-center flex sm:block items-center justify-between sm:justify-start gap-4">
            <div className="font-black leading-none mb-1 text-gold-300"
                 style={{ fontSize: 28, letterSpacing: '-1px' }}>
              {s.num}
            </div>
            <div className="text-xs font-bold uppercase tracking-wider text-white/45">
              {s.label}
            </div>
          </div>
        ))}
      </div>

      {/* ── Pain section ─────────────────────────────────────────────────── */}
      <section className="px-8 py-20" style={{ background: '#F8F9FA' }}>
        <div className="mx-auto" style={{ maxWidth: 900 }}>
          <p className="text-xs font-bold uppercase tracking-widest mb-3 text-brand-800">
            Sound familiar?
          </p>
          <h2 className="font-display font-bold mb-2 tracking-tight text-brand-800"
              style={{ fontSize: 'clamp(28px, 4vw, 38px)', letterSpacing: '-1px' }}>
            Managing properties today is chaotic.
          </h2>
          <p className="mb-10 text-base text-gray-500">
            If any of these describe your week, FieldStay was built for you.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              {
                icon: MessageSquare,
                title: 'Coordinating cleaners over group text',
                body: 'Scrolling back through 40 messages trying to figure out if someone confirmed Saturday\'s checkout.',
              },
              {
                icon: Package,
                title: 'Finding out you\'re out of supplies at 9pm',
                body: 'Crew texts you mid-turnover that there\'s no laundry pods. Next guests check in tomorrow at 3pm.',
              },
              {
                icon: Wrench,
                title: 'Chasing vendors for work order updates',
                body: 'You submitted the repair request two weeks ago. Still no idea if anyone has looked at it.',
              },
              {
                icon: BarChart3,
                title: 'Copy-pasting P&Ls to owners every month',
                body: 'Manually pulling numbers from your booking platform and pasting them into a spreadsheet to email out.',
              },
            ].map((item) => (
              <div key={item.title}
                   className="flex items-start gap-4 rounded-xl p-5 border border-gray-200"
                   style={{ background: '#fff' }}>
                <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center"
                     style={{ background: '#FFF8E7' }}>
                  <item.icon className="w-5 h-5 text-gray-900" />
                </div>
                <div>
                  <p className="font-bold text-sm mb-1 text-gray-900">{item.title}</p>
                  <p className="text-sm leading-relaxed text-gray-500">{item.body}</p>
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
            <h2 className="font-display font-bold mb-3 tracking-tight text-brand-800"
                style={{ fontSize: 'clamp(28px, 4vw, 38px)', letterSpacing: '-1px' }}>
              Built for every part of the operation.
            </h2>
            <p className="text-base mx-auto text-gray-500" style={{ maxWidth: 480 }}>
              FieldStay handles operations so you can focus on growing your portfolio.
            </p>
          </div>

          {/* ── Feature grid: F1 + F2 ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">

            {/* Feature 1 — Offline Crew App */}
            <div className="rounded-2xl p-7 relative overflow-hidden border border-gray-200">
              <div className="absolute top-0 left-0 right-0 h-[3px] rounded-t-2xl bg-brand-800" />
              <span className="inline-block rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest mb-4 bg-brand-50 text-brand-800">
                Crew Mobile App
              </span>
              <h3 className="font-display font-bold mb-3 tracking-tight text-gray-900"
                  style={{ fontSize: 20, letterSpacing: '-0.3px' }}>
                Your crew has to work fast even without a signal. Their app should too.
              </h3>
              <p className="text-sm leading-relaxed text-gray-500">
                The FieldStay crew app works completely offline. Checklists, inventory counts,
                and photos all function with zero cell service — everything syncs automatically
                when signal is restored. No spinning wheels. No excuses for an incomplete turnover.
              </p>
            </div>

            {/* Feature 2 — Smart Crew Scheduling */}
            <div className="rounded-2xl p-7 relative overflow-hidden border border-gray-200">
              <div className="absolute top-0 left-0 right-0 h-[3px] rounded-t-2xl bg-brand-800" />
              <span className="inline-block rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest mb-4 bg-brand-50 text-brand-800">
                Intelligent Scheduling
              </span>
              <h3 className="font-display font-bold mb-3 tracking-tight text-gray-900"
                  style={{ fontSize: 20, letterSpacing: '-0.3px' }}>
                Suggested crew assignment that gets smarter every turnover.
              </h3>
              <p className="text-sm leading-relaxed text-gray-500">
                FieldStay suggests the right crew member for each turnover based on familiarity
                with the property, geographic proximity, workload, and completion history. The
                more turnovers you run through it, the better it gets. Operations shouldn&apos;t
                feel like groundhog day every week.
              </p>
            </div>

            {/* Feature 3 — Flat Pricing */}
            <div className="rounded-2xl p-7 relative overflow-hidden border border-gray-200">
              <div className="absolute top-0 left-0 right-0 h-[3px] rounded-t-2xl bg-brand-800" />
              <span className="inline-block rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest mb-4 bg-brand-50 text-brand-800">
                Pricing
              </span>
              <h3 className="font-display font-bold mb-3 tracking-tight text-gray-900"
                  style={{ fontSize: 20, letterSpacing: '-0.3px' }}>
                Gates are for fences. Not features.
              </h3>
              <p className="text-sm leading-relaxed text-gray-500">
                Every FieldStay plan includes the full platform — no feature gating, no
                per-property fees that punish growth. Starter covers 1–15 properties at $199/month.
                Growth covers 16–50 at $479/month. Portfolio covers 51–100 at $799/month. Scale
                your portfolio without watching your software bill scale with it.
              </p>
            </div>

            {/* Feature 5 — RepuGuard */}
            <div className="rounded-2xl p-7 relative overflow-hidden border border-gray-200">
              <div className="absolute top-0 left-0 right-0 h-[3px] rounded-t-2xl bg-brand-800" />
              <span className="inline-block rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest mb-4 bg-brand-50 text-brand-800">
                RepuGuard
              </span>
              <h3 className="font-display font-bold mb-3 tracking-tight text-gray-900"
                  style={{ fontSize: 20, letterSpacing: '-0.3px' }}>
                A professional review response that sounds as authentic as you. One click to post.
              </h3>
              <p className="text-sm leading-relaxed text-gray-500">
                RepuGuard generates a tailored draft response for every guest review synced from
                your PMS — ready before you&apos;ve had your morning coffee. Review it, edit it if you
                want, and post directly back to your PMS in one click. Bundled into every plan.
              </p>
            </div>
          </div>

        </div>
      </section>

      {/* ── Feature 4 — Guest Guidebook (highlighted band) ───────────────── */}
      <section className="px-8 py-16 bg-brand-800">
        <div className="mx-auto" style={{ maxWidth: 960 }}>
          <div className="rounded-2xl p-8 md:p-10 bg-white/5 border border-white/12">
            <span className="inline-block rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest mb-5 bg-gold-300/15 text-gold-300 border border-gold-300/30">
              Guest Guidebook
            </span>
            <h3 className="font-display font-bold mb-4 tracking-tight text-white"
                style={{ fontSize: 'clamp(22px, 3vw, 28px)', letterSpacing: '-0.5px', maxWidth: 680 }}>
              Not just another guidebook. A guest experience tool with a personal touch — and we&apos;ll pay you to use it.*
            </h3>
            <p className="text-base leading-relaxed mb-3 text-white/60" style={{ maxWidth: 700 }}>
              Every FieldStay property gets a personalized guest guidebook: door codes, WiFi
              credentials, check-in instructions, and contextual recommendations driven by
              your property&apos;s amenities and live weather. Guests opt in to receive their door
              code by text — the moment they submit their number, your opt-in rate is nearly
              complete. Local business sponsors pay $15/month for featured placement. At 5
              active sponsors, you earn a $10/month plan credit. At 6, it&apos;s $25/month.
            </p>
            <p className="text-xs text-white/30">
              *Plan credits applied monthly based on active sponsor count. Subject to plan tier.
            </p>
          </div>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section className="px-8 py-20 text-center bg-brand-800">
        <div className="mx-auto" style={{ maxWidth: 800 }}>
          <h2 className="font-display font-bold mb-3 tracking-tight text-white"
              style={{ fontSize: 'clamp(28px, 4vw, 38px)', letterSpacing: '-1px' }}>
            Up and running in minutes.
          </h2>
          <p className="mb-14 text-base text-white/50">
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
                desc: 'Set inventory par levels, build your turnover checklist, add maintenance schedules, invite your crew. Takes about 15 minutes per property.',
              },
              {
                n: '03',
                title: 'Run on autopilot',
                desc: 'Turnovers generate, crew works offline, purchase orders send themselves, owners see their P&L. You manage exceptions, not logistics.',
              },
            ].map((step) => (
              <div key={step.n}
                   className="rounded-2xl p-7 bg-white/6 border border-white/10">
                <div className="font-black mb-3 leading-none text-gold-300/20"
                     style={{ fontSize: 40, letterSpacing: '-2px' }}>
                  {step.n}
                </div>
                <p className="font-bold mb-2 text-white" style={{ fontSize: 17 }}>{step.title}</p>
                <p className="text-sm leading-relaxed text-white/50">
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
            <h2 className="font-display font-bold mb-2 tracking-tight text-brand-800"
                style={{ fontSize: 'clamp(28px, 4vw, 38px)', letterSpacing: '-1px' }}>
              Simple, transparent pricing.
            </h2>
            <p className="text-sm text-gray-500">
              Full software on every plan. No features gated by tier.
            </p>
          </div>

          {/* Billing toggle */}
          <div className="flex items-center justify-center gap-3 mb-9">
            <span className={cn('text-sm font-bold', annual ? 'text-gray-400' : 'text-brand-800')}>
              Monthly
            </span>
            <button
              onClick={() => setAnnual(!annual)}
              aria-pressed={annual}
              aria-label={annual ? 'Switch to monthly billing' : 'Switch to annual billing'}
              className="relative rounded-full transition-colors bg-brand-800 border-none cursor-pointer"
              style={{ width: 48, height: 26 }}
            >
              <span className="absolute top-[3px] rounded-full transition-transform bg-gold-300"
                    style={{
                      width: 20, height: 20,
                      left: 3,
                      transform: annual ? 'translateX(22px)' : 'translateX(0)',
                      display: 'block',
                      transition: 'transform 0.2s',
                    }} />
            </button>
            <span className={cn('text-sm font-bold flex items-center gap-2', annual ? 'text-brand-800' : 'text-gray-400')}>
              Annual
              <span className="rounded-full px-2 py-0.5 text-xs font-black bg-gold-300 text-brand-800">
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
                monthly: 479, annual: 4790,
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
                monthly: 799, annual: 7990,
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
                   className={cn(
                     'rounded-2xl p-7 flex flex-col bg-white',
                     plan.highlight
                       ? 'border-2 border-brand-800 ring-4 ring-brand-800/7'
                       : 'border-[1.5px] border-gray-200'
                   )}>
                {plan.badge && (
                  <span className="self-start rounded-full px-3 py-1 text-xs font-black uppercase tracking-wider mb-4 bg-gold-300 text-brand-800">
                    {plan.badge}
                  </span>
                )}
                <p className="font-black mb-1 text-gray-900" style={{ fontSize: 18 }}>
                  {plan.name}
                </p>
                <p className="text-xs mb-1 text-gray-500">{plan.description}</p>
                <p className="text-sm mb-5 text-gray-400">{plan.props}</p>

                {/* Price */}
                <div className="mb-5">
                  {plan.monthly !== null ? (
                    <>
                      <span className="font-black tracking-tight text-brand-800"
                            style={{ fontSize: 42, letterSpacing: '-2px', lineHeight: 1 }}>
                        {annual ? `$${plan.annual!.toLocaleString()}` : `$${plan.monthly}`}
                      </span>
                      <span className="text-sm ml-1 text-gray-400">
                        {annual ? '/yr' : '/mo'}
                      </span>
                      {!annual && (
                        <p className="text-xs mt-1 text-gray-400">
                          or ${plan.annual!.toLocaleString()}/yr — save ${(plan.monthly! * 12 - plan.annual!)}
                        </p>
                      )}
                    </>
                  ) : (
                    <span className="font-black text-brand-800" style={{ fontSize: 34, letterSpacing: '-1px' }}>
                      Custom
                    </span>
                  )}
                </div>

                <div className="mb-5 bg-gray-100" style={{ height: 1 }} />

                <div className="flex flex-col gap-2.5 flex-1 mb-6">
                  {plan.features.map((f) => (
                    <div key={f} className="flex items-start gap-2 text-sm text-gray-700">
                      <span className="flex-shrink-0 flex items-center justify-center rounded-full mt-0.5 bg-brand-800 text-gold-300"
                            style={{ width: 18, height: 18, minWidth: 18 }}>
                        <Check className="w-3 h-3" strokeWidth={3} />
                      </span>
                      {f}
                    </div>
                  ))}
                </div>

                <Link href={plan.ctaHref}
                      className={cn(
                        'block text-center rounded-lg font-bold text-sm py-3 transition-opacity',
                        plan.highlight
                          ? 'bg-gold-300 text-brand-800'
                          : plan.monthly === null
                          ? 'bg-transparent text-brand-800 border-[1.5px] border-gray-200'
                          : 'bg-brand-800 text-white'
                      )}>
                  {plan.cta}
                </Link>
              </div>
            ))}
          </div>

          <p className="text-center text-xs mt-6 text-gray-400">
            All plans include a 14-day free trial. No credit card required. Annual billing saves approximately 2 months.
          </p>
        </div>
      </section>

      {/* ── Bottom CTA ───────────────────────────────────────────────────── */}
      <section className="px-8 py-20 text-center bg-gold-300">
        <h2 className="font-display font-bold mb-3 tracking-tight text-brand-800"
            style={{ fontSize: 'clamp(28px, 4vw, 38px)', letterSpacing: '-1px' }}>
          Ready to stop firefighting?
        </h2>
        <p className="text-base mb-9 mx-auto text-brand-800/62" style={{ maxWidth: 440 }}>
          Join property managers who replaced their texts and spreadsheets with one platform that actually works.
        </p>
        <Link href="/signup"
              className="inline-flex items-center gap-2 rounded-lg font-black text-base transition-opacity bg-brand-800 text-white"
              style={{ padding: '16px 36px' }}>
          Start Free — 14 Days Free <span style={{ fontSize: 20 }}>→</span>
        </Link>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="flex items-center justify-between px-8 py-7 bg-brand-900">
        <span className="font-display font-bold text-base text-white">
          Field<span className="text-gold-300">Stay</span>
        </span>
        <div className="flex items-center gap-6">
          {[
            { label: 'hello@fieldstay.app', href: 'mailto:hello@fieldstay.app' },
            { label: 'Log In', href: '/login' },
            { label: 'Sign Up', href: '/signup' },
          ].map((l) => (
            <Link key={l.label} href={l.href}
                  className="text-sm transition-colors text-white/40">
              {l.label}
            </Link>
          ))}
        </div>
      </footer>

    </div>
  )
}
