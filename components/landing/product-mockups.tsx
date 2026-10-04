import type { ReactNode } from 'react'
import { Wifi, MapPin, KeyRound } from 'lucide-react'

// ============================================================================
// The product mockups: hand-built re-creations of real, shipping FieldStay
// surfaces, used by the marketing pages.
//
// Extracted verbatim from homepage-content.tsx on 2026-10-03, when /features
// became the second page to need them. Not copied: a second copy of a
// pixel-accurate re-creation would drift from the product AND from its twin,
// and these already carry a standing promise (below) that is hard enough to
// keep once.
//
// ── THE STANDING PROMISE, moved here with them ─────────────────────────────
//
// Every panel below mirrors a real file: turnover-board.tsx, the crew
// ChecklistView, the vendor work-order portal, the owner capex table, and
// guest-guidebook-view.tsx. They are kept close enough to those files' own
// markup, copy and status colours that a screenshot of either would read as
// the same product. IF ONE OF THOSE SURFACES CHANGES ITS LAYOUT OR COPY,
// CHANGE THE MATCHING PANEL HERE, or the marketing site shows a product that
// no longer exists.
//
// ── WHY THE COLOURS ARE LITERAL HEX, AND MUST STAY THAT WAY FOR NOW ────────
//
// This file carries ~200 hex literals across 63 distinct values, which looks
// like a violation of CLAUDE.md's "CSS variables for all colors" rule. It is a
// deliberate exception, for a reason specific to this file: these are not
// marketing colours, they are a RE-CREATION of the product's own UI chrome.
// They must track app/(dashboard)/** and the crew PWA, NOT the --mkt-*
// palette, and wiring them to marketing tokens would let a landing-page colour
// tweak silently falsify a screenshot of the product.
//
// They should still become tokens, in their own --mkt-app-* / --mkt-status-*
// family that mirrors the dashboard rather than the marketing page. That is
// real work (63 values, pixel-accurate panels, no automated check to catch a
// mistake, since the Tailwind ratchet only matches utility class names and
// never sees an inline hex) and it is deliberately NOT bundled into the move.
// The move is verbatim so it can be verified by comparing rendered output.
// ============================================================================

// Wraps a desktop-fidelity screen mockup (fixed intrinsic px width — the
// board, invoice and capex panels below) so it never gets squeezed illegible
// on a phone. Below its own width it scrolls horizontally at full fidelity
// instead of reflowing; above it, it just centers. `-webkit-overflow-
// scrolling: touch` for momentum scroll on iOS Safari, which the bare
// overflow-x-auto default does not give you.
export function MockupScroller({ children, minWidth }: Readonly<{ children: ReactNode; minWidth: number }>) {
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

// ── PM board mockup — mirrors app/(dashboard)/turnovers/turnover-board.tsx:
// the same sidebar groups, the same "Needs Crew" / suggested-assignment
// banner copy, the same status badges (Needs Crew, In Progress, Crew
// Assigned). Keep this panel's copy in lockstep with that file. ────────────
export function ManagersBoardMockup() {
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
                Suggested: <b className="text-white">Maria G.</b> <span style={{ color: '#9ab5cc' }}>cleaned this property 11 times, 4 mi away</span>
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
export function CrewChecklistMockup() {
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
            <span className="font-semibold" style={{ color: '#dce9f5' }}>Checklist, 14 of 22</span>
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
            { label: 'Photograph closet', sub: 'Photo saved, uploading when back online', subColor: '#f59e0b', done: true },
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
// "Submit Invoice, $X" button copy pulled directly from that file. ───────
export function VendorInvoiceMockup() {
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
        Submit Invoice, $189.50
      </button>
    </div>
  )
}

// ── Owner capex mockup — mirrors app/owner/[token]/page.tsx's Capital
// Planning card: 10-year projected cost, monthly reserve target, and the
// year-by-year asset list with the same red/amber/green health scoring. ──
export function OwnerCapexMockup() {
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
export function GuestGuidebookMockup() {
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
            <span className="text-[11px]" style={{ color: '#9A9AA2' }}>Clear skies through sunset, good evening for the dock.</span>
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
