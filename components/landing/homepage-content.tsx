'use client'

import { useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { MessageSquare, Package, Wrench, BarChart3 } from 'lucide-react'
import { pricingTiers } from '@/components/pricing/plan-tiers'
import PricingCards from '@/components/pricing/PricingCards'
import FaqSection from '@/components/faq/FaqSection'
import RepuGuardWrapper from '@/components/repuguard/RepuGuardWrapper'
import {
  MARKETING_OFFLINE_FAQ,
  MARKETING_TRIAL_FAQ,
  CREW_VISIBILITY_FAQ,
  TEAM_ACCESS_FAQ,
} from '@/lib/faq-content'

// The homepage's own entry-tier bullets -- the only thing that legitimately
// varies from /ownerrez and /hospitable's entry cards (their first bullet
// names the PMS they sell against; this page doesn't sell against one).
// Everything else -- prices, property ranges, every tier above this one --
// now comes from pricingTiers(), the same source those two pages read from.
//
// Before this, the pricing grid below was a hand-written 4-tier array that had
// drifted: no Hosts tier at all, and Starter labelled "Up to 15 properties"
// when the real floor moved to 5 the moment Hosts was added beneath it. The
// fix is not the corrected number, it is that there is no longer a second copy
// to correct -- unit/stripe/plan-table-consistency.test.ts already holds
// plan-tiers.ts against lib/stripe/client.ts's PLANS.
//
// The card grid ITSELF (not just the tier data) was still a second copy,
// though -- this page hand-rolled the same five-card layout
// components/pricing/PricingSection.tsx already rendered for /ownerrez and
// /hospitable, just with different classNames. That is exactly how it ended
// up stale: the graduated-pricing rebuild's "say 'from $X', not a bare '$X'"
// fix and the "no more flat tier pricing" copy fix both landed on the other
// two pages and not here. Now this page imports the same
// components/pricing/PricingCards.tsx those pages use, so a future pricing
// display fix only has to happen once.
// Every public page, linked from the highest-authority page on the site.
//
// This is not decoration. Google Search Console reported all six marketing and
// legal pages as "Discovered - currently not indexed", and inspecting any of
// them returned "URL is unknown to Google" with "Referring page: None
// detected". The cause was here: the whole 49KB homepage carried exactly two
// internal links, /login and /signup. app/sitemap.ts listed the pages and
// app/robots.ts advertised the sitemap, so the machine-readable half was
// correct -- but a sitemap entry is a hint, and a page with zero inbound links
// is one a crawler is entitled to keep ignoring. /strops had been live and
// unlinked since 2026-08-08.
//
// Legal links carry a second reason: a public privacy policy and terms are
// what a payment processor, an app store review and an ads account all look
// for, and none of them read sitemap.xml.
//
// Relative hrefs on purpose. These are same-host marketing pages, so they
// resolve on whichever of the two aliases the visitor is on and inherit that
// page's own apex canonical -- unlike a CTA into an authenticated flow, which
// lib/marketing.ts requires to be absolute against APP_ORIGIN so the session
// cookie lands on the right host.
const FOOTER_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Turnover App',  href: '/strops'      },
  { label: 'For Hosts',     href: '/hosts'       },
  { label: 'OwnerRez',      href: '/ownerrez'    },
  { label: 'Hospitable',    href: '/hospitable'  },
  { label: 'vs Breezeway',  href: '/breezeway-alternative' },
  { label: 'Privacy',       href: '/privacy'     },
  { label: 'Terms',         href: '/terms'       },
  { label: 'DPA',           href: '/dpa'         },
  { label: 'Log In',        href: '/login'       },
  { label: 'Sign Up',       href: '/signup'      },
]

const HOMEPAGE_ENTRY_FEATURES = [
  'iCal sync (Airbnb, VRBO)',
  'Turnover board + crew app',
  'Offline checklist + photo capture',
  'Inventory with auto purchase orders',
  'Maintenance + vendor portal',
  'Owner P&L portal',
  'Crew email invites',
  'RepuGuard reputation management',
] as const

// Reused verbatim from lib/faq-content.ts -- the homepage was the only public
// landing page shipping without a FAQ, and the answers already existed.
const HOMEPAGE_FAQ_ITEMS = [
  { q: MARKETING_OFFLINE_FAQ.question, a: MARKETING_OFFLINE_FAQ.answer },
  { q: MARKETING_TRIAL_FAQ.question, a: MARKETING_TRIAL_FAQ.answer },
  { q: CREW_VISIBILITY_FAQ.question, a: CREW_VISIBILITY_FAQ.answer },
  { q: TEAM_ACCESS_FAQ.question, a: TEAM_ACCESS_FAQ.answer },
] as const

export function HomepageContent() {
  const [annual, setAnnual] = useState(false)
  const tiers = pricingTiers(HOMEPAGE_ENTRY_FEATURES)

  return (
    <div className="min-h-screen">

      {/* ── Nav ──────────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 flex items-center justify-between px-8 h-16 bg-brand-800">
        <span className="font-display text-xl font-black tracking-tight text-white">
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
          For STR Property Managers Running 5–100+ Properties
        </div>

        {/* Headline */}
        <h1 className="font-display mx-auto mb-5 font-bold leading-[1.2] tracking-tight text-white"
            style={{ fontSize: 'clamp(36px, 5vw, 54px)', maxWidth: 720, letterSpacing: '-1.5px' }}>
          The STR industry is stressful. FieldStay exists with one mission:{' '}
          <span className="text-gold-300">make your day less stressful.</span>
        </h1>

        {/* Subhead */}
        <p className="mx-auto mb-9 text-white/62" style={{ fontSize: 18, maxWidth: 580, lineHeight: 1.65 }}>
          Automated turnovers. A crew app that works offline. A guest
          guidebook that pays you back every month. Just a few ways we make
          your day less stressful.
        </p>

        {/* CTA */}
        <Link href="/signup"
              className="inline-flex items-center gap-2 rounded-lg font-black text-base transition-all bg-gold-300 text-brand-800"
              style={{ padding: '16px 36px' }}>
          Start Your Free 14-Day Trial <span style={{ fontSize: 20 }}>→</span>
        </Link>
        <p className="mt-4 text-sm text-white/38">
          No credit card. No sales call. No spreadsheet migration — add your
          first property in under 15 minutes.
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
          <h2 className="font-display font-bold leading-[1.2] mb-2 tracking-tight text-brand-800"
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
            <h2 className="font-display font-bold leading-[1.2] mb-3 tracking-tight text-brand-800"
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
              <h3 className="font-display font-bold leading-[1.2] mb-3 tracking-tight text-gray-900"
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
              <h3 className="font-display font-bold leading-[1.2] mb-3 tracking-tight text-gray-900"
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

            {/* Feature 3 — No-Login Vendor Portal */}
            <div className="rounded-2xl p-7 relative overflow-hidden border border-gray-200">
              <div className="absolute top-0 left-0 right-0 h-[3px] rounded-t-2xl bg-brand-800" />
              <span className="inline-block rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest mb-4 bg-brand-50 text-brand-800">
                Vendor Portal
              </span>
              <h3 className="font-display font-bold leading-[1.2] mb-3 tracking-tight text-gray-900"
                  style={{ fontSize: 20, letterSpacing: '-0.3px' }}>
                Dispatch a work order. Get an invoice back — no login required.
              </h3>
              <p className="text-sm leading-relaxed text-gray-500">
                Send a vendor a link, not a login. They submit their line-item invoice
                from their phone, you approve it in one click, and payment lands in
                their bank account automatically. No app to install, no password to
                reset, no more &ldquo;still working on it&rdquo; texts.
              </p>
            </div>

            {/* Feature 4 — Asset Health & CapEx */}
            <div className="rounded-2xl p-7 relative overflow-hidden border border-gray-200">
              <div className="absolute top-0 left-0 right-0 h-[3px] rounded-t-2xl bg-brand-800" />
              <span className="inline-block rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest mb-4 bg-brand-50 text-brand-800">
                Asset Health
              </span>
              <h3 className="font-display font-bold leading-[1.2] mb-3 tracking-tight text-gray-900"
                  style={{ fontSize: 20, letterSpacing: '-0.3px' }}>
                Know which water heater fails next — before it does.
              </h3>
              <p className="text-sm leading-relaxed text-gray-500">
                Every appliance and system on every property gets a health score
                that updates daily based on age and expected lifespan. FieldStay
                rolls that into a 10-year capital forecast automatically —
                replacement budgets become a report you pull, not a guess you
                defend to an owner.
              </p>
            </div>

            {/* Feature 5 — RepuGuard */}
            <div className="rounded-2xl p-7 relative overflow-hidden border border-gray-200">
              <div className="absolute top-0 left-0 right-0 h-[3px] rounded-t-2xl bg-brand-800" />
              <span className="inline-block rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest mb-4 bg-brand-50 text-brand-800">
                RepuGuard
              </span>
              <h3 className="font-display font-bold leading-[1.2] mb-3 tracking-tight text-gray-900"
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

      {/* ── RepuGuard Live Demo ─────────────────────────────────────────── */}
      {/* bg-brand-900, not brand-800 -- the Guidebook band and How-it-works
          sections right after this are both brand-800, and this page already
          reuses brand-900 for the stats bar higher up. Using it here again
          breaks up three consecutive navy sections instead of stacking a
          fourth identical one. */}
      <section className="px-8 py-20 bg-brand-900">
        <div className="mx-auto text-center" style={{ maxWidth: 960 }}>
          <div className="inline-flex items-center justify-center gap-2 mb-4">
            <div className="bg-gold-300 text-brand-800 text-xs font-bold px-2.5 py-1 rounded-md tracking-wider">
              REPUGUARD
            </div>
            <span className="text-white/46 text-sm">Included with every plan</span>
          </div>
          <h2 className="font-display font-bold leading-[1.2] mb-3 tracking-tight text-white"
              style={{ fontSize: 'clamp(28px, 4vw, 38px)', letterSpacing: '-1px' }}>
            See RepuGuard in Action
          </h2>
          <p className="text-white/46 text-lg mx-auto mb-10" style={{ maxWidth: 520 }}>
            Choose a review scenario below and watch your built-in reputation
            engine generate a response in real time.
          </p>
          <RepuGuardWrapper />
        </div>
      </section>

      {/* ── Feature 4 — Guest Guidebook (highlighted band) ───────────────── */}
      <section className="px-8 py-16 bg-brand-800">
        <div className="mx-auto" style={{ maxWidth: 960 }}>
          <div className="rounded-2xl p-8 md:p-10 bg-white/5 border border-white/12">
            <span className="inline-block rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest mb-5 bg-gold-300/15 text-gold-300 border border-gold-300/30">
              Guest Guidebook
            </span>
            <h3 className="font-display font-bold leading-[1.2] mb-4 tracking-tight text-white"
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
          <h2 className="font-display font-bold leading-[1.2] mb-3 tracking-tight text-white"
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

      <FaqSection items={HOMEPAGE_FAQ_ITEMS} />

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      <section id="pricing" className="px-8 py-20" style={{ background: '#F8F9FA' }}>
        <div className="mx-auto" style={{ maxWidth: 1100 }}>
          <div className="text-center mb-10">
            <h2 className="font-display font-bold leading-[1.2] mb-2 tracking-tight text-brand-800"
                style={{ fontSize: 'clamp(28px, 4vw, 38px)', letterSpacing: '-1px' }}>
              We do business differently.
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              Simple, transparent pricing.
            </p>
            <p className="text-sm text-gray-600 mx-auto" style={{ maxWidth: 480 }}>
              Most STR software gates parts of the software behind higher
              tiers, or hits you with a steep jump the moment you add one
              more property. FieldStay doesn&apos;t. All the features, every
              tier. Add a property and the price moves a few dollars, never
              a cliff.
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

          {/* Plan cards — see components/pricing/PricingCards.tsx, shared
              with /ownerrez and /hospitable. No provider param here: the
              homepage doesn't sell against a specific PMS. */}
          <PricingCards tiers={tiers} annual={annual} signupHref="/signup" />

          <p className="text-center text-xs mt-6 text-gray-400">
            All plans include a 14-day free trial. No credit card required. Annual billing saves approximately 2 months.
          </p>
        </div>
      </section>

      {/* ── Bottom CTA ───────────────────────────────────────────────────── */}
      <section className="px-8 py-20 text-center bg-gold-300">
        <h2 className="font-display font-bold leading-[1.2] mb-3 tracking-tight text-brand-800"
            style={{ fontSize: 'clamp(28px, 4vw, 38px)', letterSpacing: '-1px' }}>
          See your first turnover automate itself today.
        </h2>
        <p className="text-base mb-9 mx-auto text-brand-800/62" style={{ maxWidth: 440 }}>
          Connect your booking platform, add your first property, and watch
          FieldStay generate the turnover, assign the crew, and queue the
          checklist — automatically. Cancel with one click if it doesn&apos;t
          save your team real time in the first week.
        </p>
        <Link href="/signup"
              className="inline-flex items-center gap-2 rounded-lg font-black text-base transition-opacity bg-brand-800 text-white"
              style={{ padding: '16px 36px' }}>
          Start Your Free 14-Day Trial <span style={{ fontSize: 20 }}>→</span>
        </Link>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="px-8 py-7 bg-brand-900">
        {/* Column on narrow screens: nine links plus the wordmark do not sit on
            one row on a phone, and the previous justify-between row would have
            crushed them rather than wrapped. */}
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-display font-black text-base text-white">
            Field<span className="text-gold-300">Stay</span>
          </span>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {FOOTER_LINKS.map((l) => (
              <Link key={l.label} href={l.href}
                    className="text-sm transition-colors text-white/40 hover:text-white/70">
                {l.label}
              </Link>
            ))}
            <a href="mailto:hello@fieldstay.app"
               className="text-sm transition-colors text-white/40 hover:text-white/70">
              hello@fieldstay.app
            </a>
          </div>
        </div>
      </footer>

    </div>
  )
}
