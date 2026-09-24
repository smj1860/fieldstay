'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useState, type ReactNode } from 'react'
import { Check, Wifi, MapPin, KeyRound } from 'lucide-react'
import { pricingTiers } from '@/components/pricing/plan-tiers'
import FaqSection from '@/components/faq/FaqSection'
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
// FOOTER_LINKS, HOMEPAGE_ENTRY_FEATURES, the pricingTiers() call, FaqSection
// and RepuGuardWrapper are UNCHANGED from the previous version of this file
// -- see the comments on each for why they exist. Do not re-derive prices,
// FAQ copy, or footer hrefs; they are the real Stripe- and SEO-backed values.
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
// Relative hrefs on purpose. These are same-host marketing pages, so they
// resolve on whichever of the two aliases the visitor is on and inherit that
// page's own apex canonical -- unlike a CTA into an authenticated flow, which
// lib/marketing.ts requires to be absolute against APP_ORIGIN so the session
// cookie lands on the right host.
const FOOTER_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Pricing',       href: '/pricing'     },
  { label: 'STR Operations', href: '/short-term-rental-operations-software' },
  { label: 'Turnover App',  href: '/strops'      },
  { label: 'For Hosts',     href: '/hosts'       },
  { label: 'Enterprise',    href: '/enterprise'  },
  { label: 'For Vendors',   href: '/for-vendors' },
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
    body: 'Bookings sync in from your PMS and calendars. FieldStay suggests who should take each turnover — and why — so you accept instead of figuring it out.',
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

// Wraps a desktop-fidelity screen mockup (fixed intrinsic px width — the
// board, invoice and capex panels below) so it never gets squeezed illegible
// on a phone. Below its own width it scrolls horizontally at full fidelity
// instead of reflowing; above it, it just centers. `-webkit-overflow-
// scrolling: touch` for momentum scroll on iOS Safari, which the bare
// overflow-x-auto default does not give you.
function MockupScroller({ children, minWidth }: Readonly<{ children: ReactNode; minWidth: number }>) {
  return (
    <div
      className="w-full overflow-x-auto"
      style={{ WebkitOverflowScrolling: 'touch', scrollbarWidth: 'thin' }}
    >
      <div style={{ minWidth, width: 'max-content', margin: '0 auto' }}>
        {children}
      </div>
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

// ── PM board mockup — mirrors app/(dashboard)/turnovers/turnover-board.tsx:
// the same sidebar groups, the same "Needs Crew" / suggested-assignment
// banner copy, the same status badges (Needs Crew, In Progress, Crew
// Assigned). Keep this panel's copy in lockstep with that file. ────────────
function ManagersBoardMockup() {
  return (
    <div className="rounded-[14px] overflow-hidden flex mx-auto shadow-2xl" style={{ width: 1080, height: 540 }}>
      <aside className="flex flex-col gap-0.5 flex-shrink-0" style={{ width: 200, background: '#0a1628', padding: '20px 12px', borderRight: '1px solid rgba(255,255,255,0.08)' }}>
        <span className="font-display font-black text-white text-lg" style={{ padding: '0 10px 18px' }}>
          Field<span style={{ color: '#FCD116' }}>Stay</span>
        </span>
        <span className="text-[10px] font-bold tracking-widest" style={{ color: '#9ab5cc', padding: '6px 10px' }}>OPS</span>
        {['Ops Snapshot', 'Bookings'].map((l) => (
          <span key={l} className="text-[13px] rounded-lg" style={{ color: '#9ab5cc', padding: '8px 10px' }}>{l}</span>
        ))}
        <span className="text-[13px] font-semibold rounded-lg" style={{ color: '#FCD116', background: 'rgba(252,209,22,0.14)', padding: '8px 10px' }}>Turnovers</span>
        {['Maintenance', 'Inventory'].map((l) => (
          <span key={l} className="text-[13px] rounded-lg" style={{ color: '#9ab5cc', padding: '8px 10px' }}>{l}</span>
        ))}
        <span className="text-[10px] font-bold tracking-widest" style={{ color: '#9ab5cc', padding: '14px 10px 6px' }}>PORTFOLIO</span>
        {['Properties', 'Assets', 'Capital Planning'].map((l) => (
          <span key={l} className="text-[13px] rounded-lg" style={{ color: '#9ab5cc', padding: '8px 10px' }}>{l}</span>
        ))}
        <span className="text-[10px] font-bold tracking-widest" style={{ color: '#9ab5cc', padding: '14px 10px 6px' }}>TEAM &amp; VENDORS</span>
        {['Crew', 'Vendors'].map((l) => (
          <span key={l} className="text-[13px] rounded-lg" style={{ color: '#9ab5cc', padding: '8px 10px' }}>{l}</span>
        ))}
      </aside>

      <main className="flex-grow flex flex-col gap-4" style={{ background: '#0e1e3e', padding: '24px 28px' }}>
        <div className="flex justify-between items-start">
          <div className="flex flex-col gap-1.5">
            <span className="text-[20px] font-bold" style={{ color: '#FCD116' }}>Turnovers</span>
            <div className="flex gap-2.5 items-center">
              <span className="text-[13px]" style={{ color: '#9ab5cc' }}>9 active</span>
              <span className="text-[11px] font-semibold rounded-full" style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.12)', padding: '3px 8px' }}>1 need crew</span>
            </div>
          </div>
          <div className="flex gap-2">
            <span className="text-[13px] font-semibold rounded-lg" style={{ color: '#dce9f5', background: '#1a3464', border: '1px solid rgba(255,255,255,0.07)', padding: '9px 14px' }}>Sync</span>
            <span className="text-[13px] font-semibold rounded-lg" style={{ color: '#FFFFFF', background: '#102246', border: '1px solid rgba(255,255,255,0.15)', padding: '9px 14px' }}>+ Add Turnover</span>
          </div>
        </div>

        <span className="text-[11px] font-bold tracking-wide uppercase" style={{ color: '#f05454' }}>Needs Attention &middot; 1</span>
        <div className="flex gap-3.5 rounded-xl" style={{ background: '#152b52', border: '1px solid rgba(240,84,84,0.3)', padding: '13px 15px' }}>
          <span className="rounded" style={{ width: 4, background: '#f05454' }} />
          <div className="flex-grow flex flex-col gap-2">
            <div className="flex gap-2 items-center">
              <strong className="text-[14px] text-white">Harbor View</strong>
              <span className="text-[12px]" style={{ color: '#9ab5cc' }}>Dadeville</span>
              <span className="text-[11px] font-semibold rounded-full" style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.12)', padding: '3px 8px' }}>Needs Crew</span>
            </div>
            <div className="flex gap-3 text-[12px]" style={{ color: '#9ab5cc' }}>
              <span><b className="font-medium" style={{ color: '#dce9f5' }}>Out:</b> Sat, Oct 3 10:00 AM</span>
              <span>&rarr;</span>
              <span><b className="font-medium" style={{ color: '#dce9f5' }}>In:</b> 3:00 PM</span>
              <span className="font-semibold" style={{ color: '#f59e0b' }}>5h window</span>
            </div>
            <div className="flex items-center gap-2.5 rounded-lg" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', padding: '8px 12px' }}>
              <span className="text-[12px]" style={{ color: '#dce9f5' }}>
                Suggested: <b className="text-white">Maria G.</b> <span style={{ color: '#9ab5cc' }}>&mdash; cleaned this property 11 times, 4 mi away</span>
              </span>
              <span className="ml-auto text-[12px] font-semibold rounded-lg" style={{ color: '#FFFFFF', background: '#2fd98c', padding: '5px 10px' }}>Accept</span>
              <span className="text-[12px]" style={{ color: '#9ab5cc' }}>Dismiss</span>
            </div>
          </div>
        </div>

        <span className="text-[11px] font-bold tracking-wide uppercase" style={{ color: '#9ab5cc' }}>Today &middot; 4</span>
        {[
          { name: 'The Dock House', area: 'Eclectic', badge: 'In Progress', badgeColor: '#a78bfa', badgeBg: 'rgba(167,139,250,0.12)', bar: '#a78bfa', out: '10:00 AM', into: '4:00 PM', win: '6h window', ini: 'DW' },
          { name: 'Cedar Cove', area: 'Alexander City', badge: 'Crew Assigned', badgeColor: '#4da6ff', badgeBg: 'rgba(77,166,255,0.10)', bar: '#4da6ff', out: '11:00 AM', into: '4:00 PM', win: '5h window', ini: 'TR' },
        ].map((t) => (
          <div key={t.name} className="flex gap-3.5 items-center rounded-xl" style={{ background: '#152b52', border: '1px solid rgba(255,255,255,0.07)', padding: '13px 15px' }}>
            <span className="rounded" style={{ width: 4, height: 38, background: t.bar }} />
            <div className="flex-grow flex flex-col gap-1.5">
              <div className="flex gap-2 items-center">
                <strong className="text-[14px] text-white">{t.name}</strong>
                <span className="text-[12px]" style={{ color: '#9ab5cc' }}>{t.area}</span>
                <span className="text-[11px] font-semibold rounded-full" style={{ color: t.badgeColor, background: t.badgeBg, padding: '3px 8px' }}>{t.badge}</span>
              </div>
              <div className="flex gap-3 text-[12px]" style={{ color: '#9ab5cc' }}>
                <span><b className="font-medium" style={{ color: '#dce9f5' }}>Out:</b> Sat, Oct 3 {t.out}</span>
                <span>&rarr;</span>
                <span><b className="font-medium" style={{ color: '#dce9f5' }}>In:</b> {t.into}</span>
                <span className="font-semibold" style={{ color: '#2fd98c' }}>{t.win}</span>
              </div>
            </div>
            <span className="rounded-full flex items-center justify-center font-bold text-[11px]" style={{ width: 30, height: 30, background: '#1a3464', color: '#dce9f5' }}>{t.ini}</span>
          </div>
        ))}
      </main>
    </div>
  )
}

// ── Crew checklist mockup — mirrors app/crew/turnovers/[id]/ChecklistView
// .tsx: property card, "Turnover Checklist N of M", the three real photo
// states (attached / queued offline / required-before-complete). ─────────
function CrewChecklistMockup() {
  return (
    <div className="rounded-[44px] mx-auto" style={{ width: 300, height: 560, background: '#0B1220', padding: '12px 12px 0' }}>
      <div className="rounded-[34px] h-full flex flex-col gap-3 overflow-hidden" style={{ background: '#0a1628', padding: '20px 16px' }}>
        <span className="text-[16px]" style={{ color: '#9ab5cc' }}>&larr;</span>

        <div className="rounded-xl flex flex-col gap-1.5" style={{ background: '#152b52', border: '1px solid rgba(255,255,255,0.07)', padding: '14px' }}>
          <strong className="text-[17px] text-white">The Dock House</strong>
          <span className="text-[11px]" style={{ color: '#4da6ff' }}>412 Shoreline Dr, Eclectic</span>
          <div className="flex gap-3 text-[12px] mt-1">
            <span style={{ color: '#9ab5cc', width: 62 }}>Checkout</span>
            <span className="text-white">10:00 AM</span>
          </div>
          <div className="flex gap-3 text-[12px]">
            <span style={{ color: '#9ab5cc', width: 62 }}>Next In</span>
            <span className="text-white">4:00 PM</span>
          </div>
        </div>

        <div className="flex justify-between">
          <strong className="text-[14px] text-white">Turnover Checklist</strong>
          <span className="text-[13px]" style={{ color: '#9ab5cc' }}>14 of 22</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-[12px]">
            <span className="font-semibold" style={{ color: '#dce9f5' }}>Checklist &mdash; 14 of 22</span>
            <span style={{ color: '#9ab5cc' }}>64%</span>
          </div>
          <div className="rounded-full" style={{ height: 7, background: '#1a3464' }}>
            <div className="rounded-full" style={{ width: '64%', height: 7, background: '#2A4B8D' }} />
          </div>
          <span className="text-[11px]" style={{ color: '#f59e0b' }}>1 photo waiting to upload</span>
        </div>

        <span className="text-[10px] font-bold tracking-wide" style={{ color: '#9ab5cc' }}>PRIMARY BEDROOM</span>
        <div className="rounded-xl flex flex-col" style={{ background: '#152b52', border: '1px solid rgba(255,255,255,0.07)' }}>
          {[
            { label: 'Strip and remake bed', sub: 'Photo attached', subColor: '#2fd98c', done: true },
            { label: 'Photograph closet', sub: 'Photo saved \u2014 uploading when back online', subColor: '#f59e0b', done: true },
          ].map((row) => (
            <div key={row.label} className="flex gap-2.5" style={{ padding: '11px 12px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2fd98c" strokeWidth="2.2" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M7.5 12.5l3 3 6-6.5" />
              </svg>
              <div className="flex flex-col gap-0.5">
                <span className="text-[13px] line-through" style={{ color: '#9ab5cc' }}>{row.label}</span>
                <span className="text-[11px]" style={{ color: row.subColor }}>{row.sub}</span>
              </div>
            </div>
          ))}
          <div className="flex gap-2.5 items-start" style={{ padding: '11px 12px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9ab5cc" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="10" /></svg>
            <span className="text-[13px] text-white flex-grow">Check under bed for guest items</span>
          </div>
          <div className="flex gap-2.5 items-start" style={{ padding: '11px 12px' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9ab5cc" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="10" /></svg>
            <div className="flex flex-col gap-0.5 flex-grow">
              <span className="text-[13px] text-white">Towels folded on bed</span>
              <span className="text-[11px]" style={{ color: '#f59e0b' }}>Photo required before completing</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Vendor invoice mockup — mirrors app/work-orders/[token]/vendor-portal
// .tsx: the "Invoice Line Items" table, "Invoice Total" summary, and the
// "Submit Invoice \u2014 $X" button copy pulled directly from that file. ────
function VendorInvoiceMockup() {
  return (
    <div className="rounded-2xl mx-auto flex flex-col gap-3 shadow-xl overflow-hidden" style={{ width: '100%', maxWidth: 400, background: '#FFFFFF', padding: '26px 24px' }}>
      <div className="flex flex-col items-center gap-0.5">
        <span className="font-display font-black text-[20px]" style={{ color: '#102246' }}>FieldStay</span>
        <span className="text-[11px]" style={{ color: '#ADB5BD' }}>Vendor Portal</span>
      </div>

      <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #DEE2E6' }}>
        <div className="flex justify-between" style={{ background: '#0D0F11', padding: '10px 12px' }}>
          <span className="text-[13px] font-semibold text-white">Dishwasher leaking</span>
          <span className="text-[11px] font-bold tracking-widest" style={{ color: '#ADB5BD' }}>WO-1042</span>
        </div>
        <div className="flex flex-col gap-2" style={{ padding: '10px 12px' }}>
          <div className="rounded" style={{ background: '#F8F9FA', borderLeft: '2px solid #FACC15', padding: '7px 10px' }}>
            <div className="text-[12px] font-semibold" style={{ color: '#0D0F11' }}>Harbor View</div>
            <div className="text-[11px]" style={{ color: '#6C757D' }}>118 Harbor Rd, Dadeville, AL</div>
          </div>
          <div className="flex gap-1.5">
            <span className="text-[11px] rounded-full" style={{ background: '#E9ECEF', color: '#495057', padding: '3px 9px' }}>Appliance</span>
            <span className="text-[11px] font-bold rounded-full" style={{ background: '#FEF3C7', color: '#92400E', padding: '3px 9px' }}>High</span>
          </div>
          <div className="text-[11px]" style={{ color: '#6C757D' }}>
            Not to Exceed: <b className="text-[13px]" style={{ color: '#0D0F11' }}>$450.00</b>
          </div>
        </div>
      </div>

      <label htmlFor="mock-technician-name" className="text-[12px] font-semibold" style={{ color: '#374151' }}>
        Technician Name <span style={{ color: '#ef4444' }}>*</span>
      </label>
      <input id="mock-technician-name" readOnly value="Luis R." className="text-[12px] rounded-lg" style={{ padding: '8px 10px', border: '1px solid #d1d5db', color: '#374151', marginTop: -6 }} />

      <span className="text-[11px] font-bold" style={{ color: '#374151', letterSpacing: '0.5px' }}>INVOICE LINE ITEMS</span>
      <div className="flex flex-col gap-1.5 text-[11px]">
        <div className="flex gap-1.5 font-semibold text-[9px]" style={{ color: '#9ca3af' }}>
          <span style={{ width: 62 }}>TYPE</span>
          <span className="flex-grow">DESCRIPTION</span>
          <span className="text-right" style={{ width: 30 }}>QTY</span>
          <span className="text-right" style={{ width: 52 }}>UNIT $</span>
        </div>
        {[
          { type: 'Labor', desc: 'Replace inlet valve', qty: '1.5', unit: '85.00' },
          { type: 'Material', desc: 'Inlet valve', qty: '1', unit: '62.00' },
        ].map((li) => (
          <div key={li.desc} className="flex gap-1.5" style={{ color: '#374151' }}>
            <span className="rounded" style={{ width: 62, border: '1px solid #d1d5db', padding: 5 }}>{li.type}</span>
            <span className="flex-grow rounded" style={{ border: '1px solid #d1d5db', padding: 5 }}>{li.desc}</span>
            <span className="text-right rounded" style={{ width: 30, border: '1px solid #d1d5db', padding: 5 }}>{li.qty}</span>
            <span className="text-right rounded" style={{ width: 52, border: '1px solid #d1d5db', padding: 5 }}>{li.unit}</span>
          </div>
        ))}
        <span className="text-[11px] font-semibold" style={{ color: '#2A4B8D' }}>+ Add line item</span>
      </div>

      <div className="flex justify-between items-center rounded-lg" style={{ background: '#f8fafc', border: '1px solid #e2e8f0', padding: '10px 14px' }}>
        <span className="text-[12px] font-bold" style={{ color: '#374151' }}>Invoice Total</span>
        <span className="text-[18px] font-extrabold" style={{ color: '#0f172a' }}>$189.50</span>
      </div>
      <button type="button" className="rounded-xl font-bold text-white text-[14px]" style={{ background: '#FF6B00', padding: 13 }}>
        Submit Invoice &mdash; $189.50
      </button>
    </div>
  )
}

// ── Owner capex mockup — mirrors app/owner/[token]/page.tsx's Capital
// Planning card: 10-year projected cost, monthly reserve target, and the
// year-by-year asset list with the same red/amber/green health scoring. ──
function OwnerCapexMockup() {
  const assets = [
    { year: '2027', range: '$1,150\u2013$1,700', name: 'Water heater', kind: 'water heater', cost: '$1,150\u2013$1,700', score: '52/100', color: '#dc2626' },
    { year: '2029', range: '$6,300\u2013$9,100', name: 'HVAC condenser', kind: 'hvac', cost: '$5,500\u2013$8,000', score: '68/100', color: '#d97706' },
    { year: null,   range: null,               name: 'Dishwasher', kind: 'dishwasher', cost: '$800\u2013$1,100', score: '71/100', color: '#d97706' },
    { year: '2032', range: '$7,400\u2013$10,500', name: 'Roof', kind: 'roof', cost: '$7,400\u2013$10,500', score: '84/100', color: '#16a34a' },
  ]
  return (
    <div className="rounded-2xl mx-auto flex flex-col shadow-xl overflow-hidden" style={{ width: 700, background: '#F8F9FA' }}>
      <div className="flex justify-between" style={{ background: '#FFFFFF', borderBottom: '1px solid #DEE2E6', padding: '18px 26px' }}>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold tracking-[0.14em]" style={{ color: '#6C757D' }}>FIELDSTAY OWNER PORTAL</span>
          <span className="text-[21px] font-bold" style={{ color: '#0D0F11' }}>Cedar Cove</span>
          <span className="text-[12px]" style={{ color: '#6C757D' }}>27 Cedar Cove Ln, Alexander City, AL</span>
        </div>
        <div className="text-right flex flex-col gap-0.5">
          <span className="text-[13px] font-medium" style={{ color: '#343A40' }}>J. Whitfield</span>
          <span className="text-[11px]" style={{ color: '#6C757D' }}>75% revenue share</span>
        </div>
      </div>
      <div className="flex flex-col gap-3" style={{ padding: '18px 26px' }}>
        <div className="rounded-xl flex flex-col gap-2.5" style={{ background: '#FFFFFF', border: '1px solid #DEE2E6', padding: '16px 18px' }}>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold tracking-wide" style={{ color: '#6C757D' }}>CAPITAL PLANNING</span>
            <span className="text-[11px]" style={{ color: '#6C757D' }}>Projected asset replacements over the next 10 years based on age, lifespan, and condition scoring.</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-lg" style={{ background: '#E9ECEF', padding: 10 }}>
              <div className="text-[11px]" style={{ color: '#6C757D' }}>10-Year Projected Cost</div>
              <div className="text-[16px] font-bold" style={{ color: '#0D0F11' }}>$14,850&ndash;$21,300</div>
            </div>
            <div className="rounded-lg" style={{ background: '#E9ECEF', padding: 10 }}>
              <div className="text-[11px]" style={{ color: '#6C757D' }}>Monthly Reserve Target</div>
              <div className="text-[16px] font-bold" style={{ color: '#0D0F11' }}>$124&ndash;$178/mo</div>
            </div>
          </div>
          {assets.map((a) => (
            <div key={a.name} className="flex flex-col gap-1.5">
              {a.year && (
                <div className="flex justify-between text-[13px]">
                  <span className="font-semibold" style={{ color: '#343A40' }}>{a.year}</span>
                  <span className="text-[11px]" style={{ color: '#6C757D' }}>{a.range}</span>
                </div>
              )}
              <div className="flex justify-between items-center rounded-lg text-[13px]" style={{ background: '#E9ECEF', padding: '8px 12px' }}>
                <span>
                  <b className="font-medium" style={{ color: '#0D0F11' }}>{a.name}</b>{' '}
                  <span className="text-[11px]" style={{ color: '#6C757D' }}>{a.kind}</span>
                </span>
                <span className="text-[11px]" style={{ color: '#6C757D' }}>
                  {a.cost} <b className="font-medium" style={{ color: a.color }}>{a.score}</b>
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Guidebook mockup — mirrors components/guidebook/guest-guidebook-view
// .tsx: the charcoal/gold guest theme (its own design language, not the
// site's navy), the weather-aware greeting, property ticket, quick-action
// row, open wifi panel, and a sponsor hero card with a redeemable offer. ──
function GuestGuidebookMockup() {
  return (
    <div className="rounded-[46px] mx-auto" style={{ width: 310, height: 610, background: '#0B1220', padding: 12 }}>
      <div className="rounded-[36px] h-full flex flex-col overflow-hidden relative" style={{ background: '#0E0E10' }}>
        <div className="rounded-b-[18px] overflow-hidden relative" style={{ background: 'linear-gradient(160deg, #33291A 0%, #211D16 70%)' }}>
          <div style={{ height: 118, position: 'relative', overflow: 'hidden' }}>
            <svg width="100%" height="100%" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
              <defs>
                <linearGradient id="skyH" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#4a3a1f" />
                  <stop offset="55%" stopColor="#33291A" />
                  <stop offset="100%" stopColor="#1a1611" />
                </linearGradient>
                <radialGradient id="sunH" cx="78%" cy="18%" r="30%">
                  <stop offset="0%" stopColor="#f2c76b" stopOpacity="0.85" />
                  <stop offset="100%" stopColor="#f2c76b" stopOpacity="0" />
                </radialGradient>
              </defs>
              <rect width="400" height="200" fill="url(#skyH)" />
              <rect width="400" height="200" fill="url(#sunH)" />
              <path d="M0 150 L60 150 L60 95 L130 55 L200 95 L200 150 Z" fill="#151210" />
              <rect x="80" y="105" width="18" height="24" rx="2" fill="#e8b95c" opacity="0.85" />
              <rect x="110" y="105" width="18" height="24" rx="2" fill="#e8b95c" opacity="0.6" />
              <rect x="150" y="105" width="18" height="24" rx="2" fill="#e8b95c" opacity="0.85" />
              <rect x="122" y="118" width="16" height="32" fill="#0e0d0b" />
            </svg>
          </div>
          <div className="flex flex-col gap-2" style={{ padding: '12px 16px 16px' }}>
            <div className="flex justify-between items-center">
              <span className="text-[13px] font-semibold" style={{ color: '#D4A537' }}>Good afternoon</span>
              <span className="text-[11px] rounded-full" style={{ color: '#F4F4F5', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.14)', padding: '4px 9px' }}>&#9728;&#65039; 79&deg;F</span>
            </div>
            <span className="text-[11px]" style={{ color: '#9A9AA2' }}>Clear skies through sunset &mdash; good evening for the dock.</span>
            <span className="text-[10px] uppercase" style={{ color: '#D4A537', letterSpacing: '1px', marginTop: 6 }}>Your stay at</span>
            <span className="text-[21px] font-extrabold text-white" style={{ letterSpacing: '-0.3px' }}>Cedar Cove</span>
            <div className="flex justify-between items-center" style={{ marginTop: 2 }}>
              <span className="text-[11px]" style={{ color: '#9A9AA2' }}>Night 2 of 3</span>
              <div className="flex gap-1.5">
                <span className="rounded-full" style={{ width: 7, height: 7, background: '#D4A537' }} />
                <span className="rounded-full" style={{ width: 7, height: 7, background: '#D4A537' }} />
                <span className="rounded-full" style={{ width: 7, height: 7, background: '#3A3A40' }} />
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2" style={{ padding: '12px 16px', marginTop: -8 }}>
          <div className="rounded-xl flex flex-col items-center gap-1" style={{ background: 'rgba(212,165,55,0.14)', border: '1px solid rgba(212,165,55,0.38)', padding: '10px 6px' }}>
            <Wifi className="w-4 h-4" style={{ color: '#D4A537' }} strokeWidth={2} />
            <span className="text-[10px] font-bold text-white">Wifi</span>
          </div>
          <div className="rounded-xl flex flex-col items-center gap-1" style={{ background: '#1D1D21', border: '1px solid #2A2A2E', padding: '10px 6px' }}>
            <MapPin className="w-4 h-4 text-white" strokeWidth={2} />
            <span className="text-[10px] font-bold text-white">Directions</span>
          </div>
          <div className="rounded-xl flex flex-col items-center gap-1" style={{ background: '#1D1D21', border: '1px solid #2A2A2E', padding: '10px 6px' }}>
            <KeyRound className="w-4 h-4 text-white" strokeWidth={2} />
            <span className="text-[10px] font-bold text-white">Check-in</span>
          </div>
        </div>

        <div className="rounded-xl flex flex-col gap-2" style={{ margin: '0 16px 14px', background: '#17171A', border: '1px solid #2A2A2E', padding: '12px 14px' }}>
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-semibold" style={{ color: '#9A9AA2' }}>Network</span>
            <span className="text-[12px] font-semibold text-white">CedarCove-Guest</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-semibold" style={{ color: '#9A9AA2' }}>Password</span>
            <span className="text-[12px] font-semibold text-white">lakeside2026</span>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 flex-grow" style={{ padding: '0 16px 16px' }}>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase text-white" style={{ letterSpacing: '1.5px' }}>Nearby</span>
            <span className="flex-grow" style={{ height: 1, background: '#2A2A2E' }} />
          </div>
          <div className="rounded-2xl overflow-hidden shadow-lg" style={{ background: '#17171A', border: '1px solid rgba(212,165,55,0.38)' }}>
            <div style={{ height: 78, position: 'relative', display: 'flex', alignItems: 'flex-end', padding: 8, overflow: 'hidden' }}>
              <svg width="100%" height="100%" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>
                <defs>
                  <linearGradient id="skyM" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3a3b3f" />
                    <stop offset="60%" stopColor="#26262b" />
                    <stop offset="100%" stopColor="#17171a" />
                  </linearGradient>
                  <radialGradient id="lampM" cx="50%" cy="30%" r="40%">
                    <stop offset="0%" stopColor="#e8c26a" stopOpacity="0.7" />
                    <stop offset="100%" stopColor="#e8c26a" stopOpacity="0" />
                  </radialGradient>
                </defs>
                <rect width="400" height="200" fill="url(#skyM)" />
                <rect x="0" y="128" width="400" height="14" fill="#1c1c1f" />
                <rect x="95" y="70" width="75" height="60" rx="2" fill="#141416" />
                <rect x="105" y="80" width="12" height="16" fill="#e8c26a" opacity="0.8" />
                <rect x="125" y="80" width="12" height="16" fill="#e8c26a" opacity="0.5" />
                <rect x="145" y="80" width="12" height="16" fill="#e8c26a" opacity="0.8" />
                <circle cx="120" cy="72" r="34" fill="url(#lampM)" />
              </svg>
              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(0deg, rgba(0,0,0,0.35), transparent 60%)' }} />
              <span className="text-[10px] rounded-full" style={{ color: '#FFE9C4', background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.15)', padding: '3px 8px', position: 'relative' }}>4 min away</span>
            </div>
            <div className="flex flex-col gap-1.5" style={{ padding: '10px 12px' }}>
              <span className="text-[13px] font-bold text-white">Lakeside Marina Grill</span>
              <span className="text-[10px]" style={{ color: '#9A9AA2' }}>Dockside tables, live music Fridays</span>
              <div className="flex justify-between items-center rounded-r-lg" style={{ background: 'rgba(212,165,55,0.14)', borderLeft: '3px solid #D4A537', padding: '7px 10px' }}>
                <div className="flex flex-col">
                  <span className="text-[8px] font-bold" style={{ color: '#D4A537', letterSpacing: '1px' }}>GUIDEBOOK EXCLUSIVE</span>
                  <span className="text-[11px] text-white">Free appetizer with entr&eacute;e</span>
                </div>
                <span className="text-[9px] font-bold rounded-full whitespace-nowrap" style={{ color: '#1A1206', background: '#D4A537', padding: '3px 8px' }}>Tap to redeem</span>
              </div>
            </div>
          </div>
        </div>
      </div>
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
      <header className="sticky top-0 z-50 flex items-center justify-between" style={{ height: 84, padding: '0 clamp(20px, 5vw, 40px)', background: '#FAF7F0', borderBottom: '1px solid #E2DACB' }}>
        <span className="font-display font-bold" style={{ fontSize: 'clamp(22px, 4.5vw, 28px)', color: '#102246', letterSpacing: '-0.5px' }}>FieldStay</span>
        <nav className="hidden md:flex items-center gap-9 text-[15px] font-medium">
          <Link href="/strops" style={{ color: '#102246' }}>How it works</Link>
          <Link href="#who" style={{ color: '#102246' }}>Who it&apos;s for</Link>
          <Link href="/pricing" style={{ color: '#102246' }}>Pricing</Link>
          <Link href="/breezeway-alternative" style={{ color: '#102246' }}>vs Breezeway</Link>
        </nav>
        <div className="flex items-center gap-3 sm:gap-5 text-[15px]">
          {/* No hamburger menu / mobile nav drawer here on purpose — the
              header's only job below md is brand + the two auth actions;
              the four nav links reappear at md: instead of collapsing into
              a drawer nobody asked for. Revisit if that becomes a problem. */}
          <Link href="/login" className="hidden sm:inline font-medium" style={{ color: '#102246' }}>Log in</Link>
          <Link href="/signup" className="font-semibold rounded-full whitespace-nowrap" style={{ background: '#102246', color: '#FFFFFF', padding: 'clamp(10px, 2.5vw, 13px) clamp(14px, 4vw, 22px)', fontSize: 'clamp(13px, 3.2vw, 15px)' }}>
            Start free trial
          </Link>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="flex flex-col lg:flex-row gap-10 lg:gap-16 items-center" style={{ padding: 'clamp(40px, 8vw, 72px) clamp(20px, 5vw, 40px) clamp(56px, 10vw, 96px)' }}>
        <div className="flex flex-col gap-7" style={{ maxWidth: 600 }}>
          {/* The eyebrow lives INSIDE the h1 so the heading carries the
              category keywords, not only the tagline. */}
          <h1 className="font-display font-semibold" style={{ fontSize: 'clamp(40px, 6vw, 72px)', lineHeight: 0.98, letterSpacing: '-2.5px', color: '#102246' }}>
            <span className="block text-xs font-bold uppercase tracking-[0.14em]" style={{ color: '#6B5B3A', fontFamily: 'var(--font-archivo), Arial, sans-serif', lineHeight: 1.5, letterSpacing: '0.14em', marginBottom: 28 }}>
              Short-term rental operations software
            </span>
            Make your day less stressful.
          </h1>
          <p className="text-xl leading-relaxed" style={{ color: '#3D4A63', maxWidth: 540 }}>
            FieldStay runs the work between checkout and check-in &mdash; turnovers, crews, supplies, repairs and owner reports &mdash; so you&apos;re not running your business out of a group text.
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
            Not just another guidebook. A guest experience tool with a personal touch &mdash; and we&apos;ll pay you to use it.*
          </h3>
          <p className="text-base leading-relaxed" style={{ color: '#3D4A63', maxWidth: 700 }}>
            Every FieldStay property gets a personalized guest guidebook: door codes, WiFi credentials, check-in instructions, and contextual recommendations driven by your property&apos;s amenities and live weather. Guests opt in to receive their door code by text &mdash; the moment they submit their number, your opt-in rate is nearly complete. Local business sponsors pay $15/month for featured placement, and every active sponsor takes $5/month off your FieldStay bill &mdash; from the first one, with no limit on how many you sign. Sign enough and the bill reaches zero.
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
            &ldquo;I spent my career in hospitality operations and logistics before I ever wrote software. I built FieldStay because I believe there&apos;s a better way to do this &mdash; and I&apos;ll be as honest with you as I can about what it does and what it costs.&rdquo;
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
              { n: '01', title: 'Add your properties', desc: 'Name, address, check-in times, door codes, Wi-Fi details \u2014 and paste your Airbnb or VRBO iCal URL. Bookings sync automatically.' },
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
            Adding a property moves the price a few dollars &mdash; never a cliff. Graduated down to $6/property. No sales call to find out what it costs.
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
          Connect your booking platform, add your first property, and watch FieldStay generate the turnover, assign the crew, and queue the checklist &mdash; automatically. Cancel with one click if it doesn&apos;t save your team real time in the first week.
        </p>
        <Link href="/signup" className="inline-flex items-center gap-2 font-black text-base rounded-lg" style={{ background: '#102246', color: '#FFFFFF', padding: '16px 36px' }}>
          Start Your Free 14-Day Trial <span style={{ fontSize: 20 }}>&rarr;</span>
        </Link>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer style={{ padding: 'clamp(40px, 8vw, 64px) clamp(20px, 5vw, 40px) clamp(28px, 6vw, 44px)', background: '#0B1830' }}>
        <div className="flex flex-col gap-14">
          <div className="flex flex-col lg:flex-row justify-between gap-10">
            <div className="flex flex-col gap-3.5" style={{ maxWidth: 320 }}>
              <span className="font-display font-bold text-2xl text-white">FieldStay</span>
              <span className="text-[15px] leading-relaxed" style={{ color: '#C9D2E6' }}>Property operations for short-term rental managers. Made in Alabama.</span>
              <a href="mailto:hello@fieldstay.app" className="text-[15px]" style={{ color: '#FCD116' }}>hello@fieldstay.app</a>
            </div>
            <div className="flex flex-wrap items-start gap-x-6 gap-y-3 text-[15px]" style={{ maxWidth: 640 }}>
              {FOOTER_LINKS.map((l) => (
                <Link key={l.label} href={l.href} className="transition-colors" style={{ color: 'rgba(201,210,230,0.7)' }}>
                  {l.label}
                </Link>
              ))}
            </div>
          </div>
          <span className="text-xs" style={{ color: '#8A96B2' }}>&copy; {new Date().getFullYear()} Lake Martin Delivery LLC, d/b/a FieldStay</span>
        </div>
      </footer>

    </div>
  )
}
