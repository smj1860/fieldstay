'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { pricingTiers } from '@/components/pricing/plan-tiers'
import FaqSection from '@/components/faq/FaqSection'
import { SiteHeader } from '@/components/landing/site-header'
import { SiteFooter } from '@/components/landing/site-footer'
import {
  MockupScroller,
  ManagersBoardMockup,
  CrewChecklistMockup,
  VendorInvoiceMockup,
  OwnerCapexMockup,
  GuestGuidebookMockup,
} from '@/components/landing/product-mockups'
import RepuGuardWrapper from '@/components/repuguard/RepuGuardWrapper'
import { HOMEPAGE_FAQ_ITEMS } from '@/app/json-ld'

// ============================================================================
// 2026-09 redesign — moved off the stacked-navy-sections SaaS template onto
// a warm editorial layout (cream/navy/gold, Source Serif headlines) with the
// role tabs showing the ACTUAL board/checklist/invoice/capex/guidebook
// screens instead of icon cards. Every persona panel below is a hand-built
// re-creation of a real, shipping surface — turnover-board.tsx, the crew
// ChecklistView, the vendor work-order portal, the owner capex table, and
// guest-guidebook-view.tsx — kept close enough to those files' own markup,
// copy and status colors that a screenshot of either would read as the same
// product. If those source files change their layout or copy, update the
// matching panel below so the homepage doesn't drift into showing a product
// that no longer exists.
//
// HOMEPAGE_ENTRY_FEATURES, the pricingTiers() call, FaqSection and
// RepuGuardWrapper are UNCHANGED from the previous version of this file
// -- see the comments on each for why they exist. Do not re-derive prices or
// FAQ copy; they are the real Stripe- and SEO-backed values.
//
// FOOTER_LINKS moved to components/landing/site-footer.tsx with the footer
// itself on 2026-10-03, when /why-fieldstay became the second page needing
// one. Its "do not trim this list" note went with it, and that is still the
// rule: every public page is linked from here on purpose.
// ============================================================================

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
// The homepage's pricing section is still a ONE-CARD teaser ("Starting at
// $49/mo") linking to /pricing for the full calculator and all five tiers —
// see that section's own comment for why. `pricingTiers()` is still called
// here (below) purely to read tiers[0].monthly, the same real computed
// number /pricing, /ownerrez and /hospitable all show, not a second literal.
//
// Every public page, linked from the highest-authority page on the site.
// This is not decoration. Google Search Console reported all six marketing
// and legal pages as "Discovered - currently not indexed" when this footer
// carried only /login and /signup. Do not trim this list back down.
//

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

// Booking-platform integrations shown in the "works with" strip. Hostex,
// Lodgify and Hostaway added 2026-09 alongside the redesign — keep this in
// sync with lib/integrations/providers/ if a new provider ships or an
// existing one is deprecated.
const INTEGRATIONS = [
  'Airbnb', 'VRBO', 'Hospitable', 'OwnerRez', 'Lodgify', 'Hostaway', 'Hostex', 'Stripe',
] as const

type RoleKey = 'managers' | 'crew' | 'vendors' | 'owners' | 'guests'

interface RolePanelContent {
  key:     RoleKey
  tab:     string
  kicker:  string
  title:   string
  body:    string
  points:  readonly string[]
  linkLabel: string
  href:    string
}

const ROLE_CONTENT: readonly RolePanelContent[] = [
  {
    key: 'managers',
    tab: 'Managers',
    kicker: 'The Board',
    title: 'Every turnover in one place, sorted by what needs you.',
    body: 'Bookings sync in from your PMS and calendars. FieldStay suggests who should take each turnover, and why, so you accept instead of figuring it out.',
    points: ['Auto-sorted by urgency', 'Suggested crew assignment', 'One board, every property'],
    linkLabel: 'For managers',
    href: '/enterprise',
  },
  {
    key: 'crew',
    tab: 'Your crew',
    kicker: 'Crew app',
    title: 'Their day, on their phone, with or without signal.',
    body: 'Cleaners see today\u2019s turnovers and a room-by-room checklist. Photos and counts save on the phone and upload on their own later.',
    points: ['Checklists built per property', 'Photo proof on every room', 'Works with zero bars'],
    linkLabel: 'For crews',
    href: '/strops',
  },
  {
    key: 'vendors',
    tab: 'Vendors',
    kicker: 'Vendor link',
    title: 'A link to the job. An invoice back. Paid on approval.',
    body: 'Your plumber never makes an account. They open the link, see the job and your not-to-exceed, and invoice line by line from their phone.',
    points: ['No app, no password', 'Line-item invoices', 'Paid when you approve'],
    linkLabel: 'For vendors',
    href: '/for-vendors',
  },
  {
    key: 'owners',
    tab: 'Owners',
    kicker: 'Owner portal',
    title: 'Owners see the next ten years coming.',
    body: 'A P&L that stays current, a health score on every major asset, and a replacement plan with a monthly reserve target.',
    points: ['Always-current P&L', 'Health score on every asset', '10-year plan, monthly reserve'],
    linkLabel: 'For owners',
    href: '/owner-portal',
  },
  {
    key: 'guests',
    tab: 'Guests',
    kicker: 'Guidebook',
    title: 'A guidebook that pays part of your bill.',
    body: 'A weather-aware greeting, WiFi, and offers from nearby local sponsors your guests can redeem on the spot. Each sponsor takes $5 a month off your FieldStay bill.',
    points: ['Weather-aware greeting', 'Local offers, tap to redeem', 'Sponsors lower your bill'],
    linkLabel: 'About the guidebook',
    href: '/short-term-rental-operations-software#guidebook',
  },
]

function RoleTabs({ active, onChange }: Readonly<{ active: RoleKey; onChange: (key: RoleKey) => void }>) {
  return (
    <div role="tablist" aria-label="Who FieldStay is for" className="flex flex-wrap gap-2.5">
      {ROLE_CONTENT.map((r) => {
        const isActive = r.key === active
        return (
          <button
            key={r.key}
            type="button"
            role="tab"
            id={`role-tab-${r.key}`}
            aria-selected={isActive}
            aria-controls={`role-panel-${r.key}`}
            onClick={() => onChange(r.key)}
            className="text-base font-semibold rounded-full px-6 py-3 transition-colors"
            style={{
              border: '1.5px solid #102246',
              background: isActive ? '#102246' : '#FFFFFF',
              color:      isActive ? '#FFFFFF' : '#102246',
            }}
          >
            {r.tab}
          </button>
        )
      })}
    </div>
  )
}

function RolePointList({ points }: Readonly<{ points: readonly string[] }>) {
  return (
    <div className="flex flex-col gap-2.5">
      {points.map((p) => (
        <div key={p} className="flex items-center gap-3 text-base font-semibold" style={{ color: '#102246' }}>
          <Check className="w-5 h-5 flex-shrink-0" style={{ color: '#1F6B45' }} strokeWidth={2.6} />
          <span>{p}</span>
        </div>
      ))}
    </div>
  )
}


function RolePanelCopy({ content, wide = false }: Readonly<{ content: RolePanelContent; wide?: boolean }>) {
  return (
    <div className="flex flex-col gap-4" style={{ width: '100%', maxWidth: wide ? undefined : 400, flexShrink: 0 }}>
      <span className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: '#6B5B3A' }}>
        {content.kicker}
      </span>
      <span className="font-display font-semibold leading-[1.1] tracking-tight" style={{ fontSize: 34, color: '#102246' }}>
        {content.title}
      </span>
      <span className="text-base leading-relaxed" style={{ color: '#3D4A63' }}>
        {content.body}
      </span>
      <RolePointList points={content.points} />
      <Link href={content.href} className="text-sm font-bold" style={{ color: '#102246' }}>
        {content.linkLabel} &rarr;
      </Link>
    </div>
  )
}


// Panels whose intrinsic mockup width is dense enough (a real dashboard, a
// real data table) that shrinking it to fit a phone would make it illegible
// rather than just smaller. These get MockupScroller; the phone-shaped ones
// (crew, guests — already ~300px, i.e. already phone width) and the form-
// shaped one (vendors — reads fine reflowed narrower) don't need it.
const SCROLL_ON_MOBILE: Partial<Record<RoleKey, number>> = {
  managers: 1080,
  owners:   700,
}

function RolePanel({ content }: Readonly<{ content: RolePanelContent }>) {
  if (content.key === 'managers') {
    return (
      <div className="rounded-[28px] flex flex-col gap-9" style={{ background: '#F2ECDF', padding: 'clamp(24px, 5vw, 48px) clamp(20px, 5vw, 56px) 0' }}>
        <div className="flex flex-col lg:flex-row gap-8 lg:gap-14 items-start">
          <RolePanelCopy content={content} wide />
        </div>
        <div className="flex justify-center pb-2">
          <MockupScroller minWidth={SCROLL_ON_MOBILE.managers!}>
            <ManagersBoardMockup />
          </MockupScroller>
        </div>
      </div>
    )
  }

  const mockups: Record<Exclude<RoleKey, 'managers'>, ReactNode> = {
    crew:    <CrewChecklistMockup />,
    vendors: <VendorInvoiceMockup />,
    owners:  <OwnerCapexMockup />,
    guests:  <GuestGuidebookMockup />,
  }
  const scrollWidth = SCROLL_ON_MOBILE[content.key]

  return (
    <div
      className="rounded-[28px] flex flex-col lg:flex-row lg:justify-between gap-8 lg:gap-14 overflow-hidden"
      style={{ background: '#F2ECDF', padding: 'clamp(28px, 6vw, 56px) clamp(20px, 6vw, 64px) 0', minHeight: 'auto' }}
    >
      <RolePanelCopy content={content} />
      <div className="flex-grow flex justify-center items-end pb-2">
        {scrollWidth
          ? <MockupScroller minWidth={scrollWidth}>{mockups[content.key as Exclude<RoleKey, 'managers'>]}</MockupScroller>
          : mockups[content.key as Exclude<RoleKey, 'managers'>]}
      </div>
    </div>
  )
}

export function HomepageContent() {
  const tiers = pricingTiers(HOMEPAGE_ENTRY_FEATURES)
  const [role, setRole] = useState<RoleKey>('managers')

  return (
    <div className="min-h-screen" style={{ background: '#FAF7F0', color: '#14213D', fontFamily: 'var(--font-archivo), Arial, sans-serif' }}>

      {/* ── Nav ──────────────────────────────────────────────────────────── */}
      <SiteHeader
        links={[
          { label: 'How it works',  href: '/strops' },
          { label: "Who it's for",  href: '#who' },
          { label: 'Pricing',       href: '/pricing' },
          { label: 'vs Breezeway',  href: '/breezeway-alternative' },
        ]}
      />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="flex flex-col lg:flex-row gap-10 lg:gap-16 items-center" style={{ padding: 'clamp(40px, 8vw, 72px) clamp(20px, 5vw, 40px) clamp(56px, 10vw, 96px)' }}>
        <div className="flex flex-col gap-7" style={{ maxWidth: 600 }}>
          {/* The eyebrow lives INSIDE the h1 so the heading carries the
              category keywords, not only the tagline. */}
          <h1 className="font-display font-semibold" style={{ fontSize: 'clamp(40px, 6vw, 72px)', lineHeight: 0.98, letterSpacing: '-2.5px', color: '#102246' }}>
            <span className="block text-xs font-bold uppercase tracking-[0.14em]" style={{ color: '#6B5B3A', fontFamily: 'var(--font-archivo), Arial, sans-serif', lineHeight: 1.5, letterSpacing: '0.14em', marginBottom: 28 }}>
              Short-term rental operations software
            </span>{' '}
            Make your day less stressful.
          </h1>
          <p className="text-xl leading-relaxed" style={{ color: '#3D4A63', maxWidth: 540 }}>
            FieldStay runs the work between checkout and check-in (turnovers, crews, supplies, repairs and owner reports) so you&apos;re not running your business out of a group text.
          </p>
          <div className="flex flex-wrap gap-3.5 items-center">
            <Link href="/signup" className="font-bold text-base rounded-full" style={{ background: '#FCD116', color: '#102246', padding: '18px 28px' }}>
              Start your free 14-day trial
            </Link>
            <a href="#who" className="font-semibold text-base rounded-full" style={{ padding: '18px 24px', border: '1.5px solid #102246', color: '#102246' }}>
              See a turnover run
            </a>
          </div>
          <p className="text-sm" style={{ color: '#5B6478' }}>
            No credit card. No sales call. First property set up in about 15 minutes.
          </p>
        </div>

        {/* Below lg, this collage cannot stay an absolute-positioned overlay
            — three elements with fixed left/top/width offsets tuned for a
            620px-wide photo do not degrade gracefully on a 375px viewport,
            they overlap. So position/offset/width live in className with an
            lg: prefix (Tailwind can be responsive; inline `style` can't
            without JS), and everything below lg is a plain stacked flow:
            photo, then the two info cards, full width, in document order. */}
        <div className="relative flex-grow w-full h-auto lg:h-[640px]">
          <div className="relative lg:absolute w-full lg:w-[620px] lg:right-0 lg:top-0 overflow-hidden rounded-[28px]" style={{ height: 'clamp(240px, 42vw, 600px)' }}>
            <Image
              src="/marketing/hero-crew-supplies.jpg"
              alt="A FieldStay crew member carrying fresh supplies up to a lakeside cabin"
              fill
              sizes="(min-width: 1024px) 620px, 100vw"
              className="object-cover"
              priority
            />
          </div>
          <div className="relative lg:absolute mt-4 lg:mt-0 w-full lg:w-[380px] lg:left-0 lg:bottom-0 rounded-2xl flex gap-3.5 shadow-2xl" style={{ background: '#152b52', border: '1px solid rgba(255,255,255,0.07)', padding: '16px 18px' }}>
            <span className="rounded flex-shrink-0" style={{ width: 4, background: '#a78bfa' }} />
            <div className="flex flex-col gap-2 min-w-0">
              <div className="flex gap-2 items-center flex-wrap">
                <strong className="text-[15px] text-white">The Dock House</strong>
                <span className="text-[11px] font-semibold rounded-full" style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.12)', padding: '3px 8px' }}>In Progress</span>
              </div>
              <span className="text-[12px]" style={{ color: '#9ab5cc' }}>
                <b className="font-medium" style={{ color: '#dce9f5' }}>Out:</b> 10:00 AM &rarr; <b className="font-medium" style={{ color: '#dce9f5' }}>In:</b> 4:00 PM <span className="font-semibold" style={{ color: '#2fd98c' }}>&middot; 6h window</span>
              </span>
              <div className="rounded-full w-full" style={{ height: 6, maxWidth: 300, background: '#1a3464' }}>
                <div className="rounded-full" style={{ width: '64%', height: 6, background: '#4da6ff' }} />
              </div>
              <span className="text-[11px]" style={{ color: '#9ab5cc' }}>Checklist 14 of 22 &middot; synced 2 min ago</span>
            </div>
          </div>
          <div className="relative lg:absolute mt-3 lg:mt-0 w-full lg:w-[250px] lg:left-[250px] lg:top-10 rounded-2xl shadow-xl" style={{ background: '#102246', color: '#FFFFFF', padding: '14px 18px', fontSize: 14, lineHeight: 1.45 }}>
            <strong style={{ color: '#FCD116' }}>Supplies low at Cedar Cove</strong><br />Purchase order sent. Nobody had to text anyone.
          </div>
        </div>
      </section>

      {/* ── Works with ───────────────────────────────────────────────────── */}
      <section className="flex items-center gap-6 lg:gap-11 flex-wrap" style={{ padding: 'clamp(24px, 5vw, 32px) clamp(20px, 5vw, 40px)', borderTop: '1px solid #E2DACB', borderBottom: '1px solid #E2DACB' }}>
        <span className="text-sm" style={{ color: '#5B6478', width: '100%', maxWidth: 180 }}>Syncs with the tools you already use</span>
        <div className="flex gap-6 sm:gap-9 flex-wrap font-bold" style={{ fontSize: 'clamp(16px, 3vw, 20px)', color: '#7A7466', letterSpacing: '-0.3px' }}>
          {INTEGRATIONS.map((name) => <span key={name}>{name}</span>)}
        </div>
      </section>

      {/* ── Role tabs: everyone gets their piece of the job ─────────────── */}
      <section id="who" className="flex flex-col gap-8 lg:gap-10" style={{ padding: 'clamp(56px, 12vw, 120px) clamp(20px, 5vw, 40px) clamp(24px, 4vw, 40px)' }}>
        <h2 className="font-display font-semibold leading-[1.05] tracking-tight" style={{ fontSize: 'clamp(36px, 4.5vw, 60px)', letterSpacing: '-1.5px', color: '#102246', maxWidth: 900 }}>
          Everyone gets their piece of the job. Nobody gets a login they don&apos;t need.
        </h2>
        <RoleTabs active={role} onChange={setRole} />
        {/* Every panel is server-rendered and the inactive ones are only
            `hidden`, never unmounted: crawlers and AI answer engines read the
            initial HTML and do not click tabs, so a panel rendered only on
            click is content the search index never sees. */}
        {ROLE_CONTENT.map((r) => (
          <div key={r.key} role="tabpanel" id={`role-panel-${r.key}`} aria-labelledby={`role-tab-${r.key}`} hidden={r.key !== role}>
            <RolePanel content={r} />
          </div>
        ))}
      </section>

      {/* ── A Saturday checkout, handled ─────────────────────────────────── */}
      <section className="flex flex-col gap-10 lg:gap-14" style={{ padding: 'clamp(56px, 12vw, 120px) clamp(20px, 5vw, 40px) clamp(56px, 11vw, 110px)' }}>
        <div className="flex flex-col lg:flex-row justify-between items-end gap-6">
          <h2 className="font-display font-semibold leading-[1.05] tracking-tight" style={{ fontSize: 'clamp(30px, 3.8vw, 48px)', letterSpacing: '-1.5px', color: '#102246', maxWidth: 640 }}>
            A Saturday checkout, handled.
          </h2>
          <p className="text-lg leading-relaxed" style={{ color: '#3D4A63', maxWidth: 460 }}>
            Here&apos;s what happens between one guest leaving and the next one pulling in. You don&apos;t touch any of it unless something needs you.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {[
            { time: '10:00 am', title: 'Guest checks out', body: 'The booking synced from your PMS days ago. The turnover already exists.', dark: false },
            { time: '10:02 am', title: 'The right cleaner is on it', body: 'Suggested by who knows the house, who\u2019s closest, and who has room in their day.', dark: false },
            { time: '12:40 pm', title: 'Checklist done, no signal', body: 'Photos and counts sync the moment the crew hits the main road.', dark: false },
            { time: '3:00 pm', title: 'Next guest walks in', body: 'Door code texted, guidebook ready, and you found out it went fine from a notification.', dark: true },
          ].map((step) => (
            <div key={step.time} className="rounded-2xl flex flex-col gap-3.5" style={step.dark
              ? { background: '#102246', color: '#FFFFFF', padding: 28 }
              : { background: '#FFFFFF', border: '1px solid #E2DACB', padding: 28 }}>
              <span className="font-display font-semibold" style={{ fontSize: 34, color: step.dark ? '#FCD116' : '#102246' }}>{step.time}</span>
              <span className="text-lg font-bold">{step.title}</span>
              <span className="text-sm leading-relaxed" style={{ color: step.dark ? '#C9D2E6' : '#3D4A63' }}>{step.body}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Vendor photo row ──────────────────────────────────────────────── */}
      <section className="flex flex-col-reverse lg:flex-row gap-10 lg:gap-16 items-center" style={{ padding: 'clamp(24px, 5vw, 40px) clamp(20px, 5vw, 40px) clamp(56px, 11vw, 110px)' }}>
        <div className="flex flex-col gap-5" style={{ maxWidth: 520 }}>
          <span className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: '#6B5B3A' }}>For your vendors</span>
          <h3 className="font-display font-semibold leading-[1.08] tracking-tight" style={{ fontSize: 'clamp(28px, 3.2vw, 46px)', color: '#102246' }}>
            Send your plumber a link, not a login.
          </h3>
          <p className="text-lg leading-relaxed" style={{ color: '#3D4A63' }}>
            They open the work order on their phone, send back a line-item invoice, and get paid when you approve it. No app to install. No &ldquo;still working on it&rdquo; texts.
          </p>
          <Link href="/for-vendors" className="font-bold text-base" style={{ color: '#102246' }}>How vendor work orders work &rarr;</Link>
        </div>
        <div className="relative rounded-[28px] overflow-hidden flex-shrink-0" style={{ width: '100%', maxWidth: 660, height: 'clamp(240px, 42vw, 460px)' }}>
          <Image
            src="/marketing/vendor-plumber-repair.jpg"
            alt="A vendor technician repairing a kitchen sink at a FieldStay property"
            fill
            sizes="660px"
            className="object-cover"
          />
        </div>
      </section>

      {/* ── RepuGuard live demo ──────────────────────────────────────────── */}
      <section style={{ padding: 'clamp(48px, 10vw, 96px) clamp(20px, 5vw, 40px)', background: '#102246' }}>
        <div className="mx-auto text-center" style={{ maxWidth: 960 }}>
          <div className="inline-flex items-center justify-center gap-2 mb-4">
            <div className="text-xs font-bold tracking-wider rounded-md" style={{ background: '#FCD116', color: '#102246', padding: '4px 10px' }}>
              REPUGUARD
            </div>
            <span className="text-sm" style={{ color: 'rgba(255,255,255,0.46)' }}>Included with every plan</span>
          </div>
          <h2 className="font-display font-semibold" style={{ fontSize: 'clamp(28px, 4vw, 40px)', letterSpacing: '-1px', color: '#FFFFFF' }}>
            See RepuGuard in action
          </h2>
          <p className="text-lg mx-auto mb-10 mt-3" style={{ color: 'rgba(255,255,255,0.55)', maxWidth: 520 }}>
            Choose a review scenario below and watch your built-in reputation engine generate a response in real time.
          </p>
          <RepuGuardWrapper />
        </div>
      </section>

      {/* ── Guest guidebook band ─────────────────────────────────────────── */}
      <section id="guidebook" style={{ padding: 'clamp(48px, 10vw, 96px) clamp(20px, 5vw, 40px)', background: '#FAF7F0' }}>
        <div className="rounded-[28px] mx-auto flex flex-col gap-4" style={{ maxWidth: 960, background: '#FFFFFF', border: '1px solid #E2DACB', padding: 'clamp(28px, 6vw, 48px) clamp(20px, 6vw, 56px)' }}>
          <span className="inline-block text-xs font-bold uppercase tracking-widest rounded-full self-start" style={{ background: 'rgba(252,209,22,0.18)', color: '#6B5B3A', border: '1px solid rgba(252,209,22,0.4)', padding: '5px 12px' }}>
            Guest Guidebook
          </span>
          <h3 className="font-display font-semibold" style={{ fontSize: 'clamp(24px, 3vw, 30px)', letterSpacing: '-0.5px', color: '#102246', maxWidth: 680 }}>
            Not just another guidebook. A guest experience tool with a personal touch, and we&apos;ll pay you to use it.*
          </h3>
          <p className="text-base leading-relaxed" style={{ color: '#3D4A63', maxWidth: 700 }}>
            Every FieldStay property gets a personalized guest guidebook: door codes, WiFi credentials, check-in instructions, and contextual recommendations driven by your property&apos;s amenities and live weather. Guests opt in to receive their door code by text. The moment they submit their number, your opt-in rate is nearly complete. Local business sponsors pay $15/month for featured placement, and every active sponsor takes $5/month off your FieldStay bill, from the first one, with no limit on how many you sign. Sign enough and the bill reaches zero.
          </p>
          <p className="text-xs" style={{ color: '#8A96B2' }}>
            *Plan credits applied monthly based on active sponsor count, capped at your plan cost.
          </p>
        </div>
      </section>

      {/* ── Founder note ─────────────────────────────────────────────────── */}
      <section style={{ margin: '0 clamp(20px, 5vw, 40px)', padding: 'clamp(32px, 7vw, 64px)', background: '#102246', borderRadius: 32 }}>
        <div className="flex flex-col gap-6 mx-auto" style={{ maxWidth: 760 }}>
          <span className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: '#FCD116' }}>Why FieldStay exists</span>
          <p className="font-display" style={{ fontSize: 'clamp(22px, 2.8vw, 32px)', lineHeight: 1.35, color: '#FFFFFF', letterSpacing: '-0.5px' }}>
            &ldquo;I spent my career in hospitality operations and logistics before I ever wrote software. I built FieldStay because I believe there&apos;s a better way to do this, and I&apos;ll be as honest with you as I can about what it does and what it costs.&rdquo;
          </p>
          <span className="text-base" style={{ color: '#C9D2E6' }}>
            <strong className="text-white">Stephen</strong> &middot; Founder, Dadeville, Alabama
          </span>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section className="text-center" style={{ padding: 'clamp(56px, 11vw, 110px) clamp(20px, 5vw, 40px)' }}>
        <div className="mx-auto" style={{ maxWidth: 800 }}>
          <h2 className="font-display font-semibold" style={{ fontSize: 'clamp(28px, 4vw, 40px)', letterSpacing: '-1px', color: '#102246' }}>
            Up and running in minutes.
          </h2>
          <p className="mb-14 mt-3 text-base" style={{ color: '#5B6478' }}>
            No implementation fees. No onboarding call required.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 text-left">
            {[
              { n: '01', title: 'Add your properties', desc: 'Name, address, check-in times, door codes, Wi-Fi details, and paste your Airbnb or VRBO iCal URL. Bookings sync automatically.' },
              { n: '02', title: 'Configure the details', desc: 'Set inventory par levels, build your turnover checklist, add maintenance schedules, invite your crew. Takes about 15 minutes per property.' },
              { n: '03', title: 'Run on autopilot', desc: 'Turnovers generate, crew works offline, purchase orders send themselves, owners see their P&L. You manage exceptions, not logistics.' },
            ].map((step) => (
              <div key={step.n} className="rounded-2xl" style={{ background: '#FFFFFF', border: '1px solid #E2DACB', padding: 28 }}>
                <div className="font-black leading-none mb-3" style={{ fontSize: 40, letterSpacing: '-2px', color: 'rgba(16,34,70,0.14)' }}>{step.n}</div>
                <p className="font-bold mb-2" style={{ fontSize: 17, color: '#102246' }}>{step.title}</p>
                <p className="text-sm leading-relaxed" style={{ color: '#5B6478' }}>{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <FaqSection items={HOMEPAGE_FAQ_ITEMS} />

      {/* ── Pricing teaser ───────────────────────────────────────────────── */}
      {/* Trimmed from the full PricingCards grid + calculator once /pricing
          shipped — indexing the entire calculator at two URLs was duplicate
          content for no benefit. id="pricing" kept for any link (including
          this page's own hero copy) that wants to jump straight here. */}
      <section id="pricing" className="flex flex-col lg:flex-row gap-8 lg:gap-12" style={{ padding: 'clamp(56px, 11vw, 110px) clamp(20px, 5vw, 40px)' }}>
        <div className="flex-grow flex flex-col gap-4 rounded-[28px]" style={{ background: '#FFFFFF', border: '1px solid #E2DACB', padding: 'clamp(28px, 6vw, 56px)' }}>
          <span className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: '#6B5B3A' }}>One published rate</span>
          <span className="font-display font-semibold" style={{ fontSize: 'clamp(42px, 8vw, 64px)', color: '#102246', letterSpacing: '-2px' }}>
            ${tiers[0]!.monthly}<span className="text-xl sm:text-2xl font-semibold" style={{ color: '#5B6478', letterSpacing: 0 }}> /month to start</span>
          </span>
          <span className="text-[17px] leading-relaxed" style={{ color: '#3D4A63', maxWidth: 520 }}>
            Adding a property moves the price a few dollars, never a cliff. Graduated down to $6/property. No sales call to find out what it costs.
          </span>
          <Link href="/pricing" className="font-bold text-base" style={{ color: '#102246' }}>See the full calculator &rarr;</Link>
        </div>
        <div className="flex flex-col gap-5 rounded-[28px]" style={{ width: '100%', maxWidth: 480, background: '#FCD116', padding: 'clamp(28px, 6vw, 48px)' }}>
          <span className="font-display font-semibold leading-[1.1] tracking-tight" style={{ fontSize: 38, color: '#102246' }}>
            Watch your first turnover run itself.
          </span>
          <span className="text-[17px] leading-relaxed" style={{ color: '#2A3550' }}>
            14 days free. Cancel with one click if it doesn&apos;t save your team real time in the first week.
          </span>
          <Link href="/signup" className="self-start font-bold text-base rounded-full mt-auto" style={{ background: '#102246', color: '#FFFFFF', padding: '18px 28px' }}>
            Start free trial
          </Link>
        </div>
      </section>

      {/* ── Bottom CTA ───────────────────────────────────────────────────── */}
      <section className="text-center" style={{ padding: 'clamp(56px, 11vw, 110px) clamp(20px, 5vw, 40px)', background: '#FCD116' }}>
        <h2 className="font-display font-semibold mx-auto" style={{ fontSize: 'clamp(28px, 4vw, 40px)', letterSpacing: '-1px', color: '#102246', maxWidth: 760 }}>
          See your first turnover automate itself today.
        </h2>
        <p className="text-base mb-9 mt-3 mx-auto" style={{ color: 'rgba(16,34,70,0.7)', maxWidth: 440 }}>
          Connect your booking platform, add your first property, and watch FieldStay generate the turnover, assign the crew, and queue the checklist, automatically. Cancel with one click if it doesn&apos;t save your team real time in the first week.
        </p>
        <Link href="/signup" className="inline-flex items-center gap-2 font-black text-base rounded-lg" style={{ background: '#102246', color: '#FFFFFF', padding: '16px 36px' }}>
          Start Your Free 14-Day Trial <span style={{ fontSize: 20 }}>&rarr;</span>
        </Link>
      </section>

      <SiteFooter />

    </div>
  )
}
