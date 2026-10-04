import Link from 'next/link'
import { SiteHeader } from '@/components/landing/site-header'
import { SiteFooter } from '@/components/landing/site-footer'
import { ParLevelChart } from '@/components/landing/features-chart'
import {
  MockupScroller,
  ManagersBoardMockup,
  CrewChecklistMockup,
  VendorInvoiceMockup,
  OwnerCapexMockup,
  GuestGuidebookMockup,
} from '@/components/landing/product-mockups'

// ============================================================================
// /features — the reference page. One long scrolling page, deliberately not
// tabbed: the homepage already owns the tabbed, role-filtered treatment, and
// this page's entire value is that it does NOT make a reader choose a role
// before seeing anything. Tabs would also mean either identical markup plus
// interaction for nothing, or genuinely hidden content on the one page whose
// job is indexable coverage.
//
// DENSITY IS THE DESIGN. Three heavy desktop mockups, two phone-shaped ones,
// one chart, and two sections with no visual at all. A page where every
// section weighs the same has no hierarchy and the reader stops partway down.
// Resist giving every feature a mockup: each one is also a permanent promise
// to keep it in step with the real surface it mirrors.
//
// Crew scheduling has THREE modes, not one, and the copy below names them with
// the product's own words: Off, Suggest, Autopilot (organizations
// .auto_assign_mode, settings-tabs.tsx, lib/inngest/functions/auto-assign-
// turnover.ts). Autopilot really does insert the assignment with nobody in the
// loop. An earlier draft of this page said assignment was "a suggestion you
// approve, never an assignment made over your head", which was both wrong and
// a worse sell than the truth. Vendors are NOT the same: vendor_auto_assign
// _mode is only 'suggest' or 'disabled', with no autopilot, so do not imply
// hands-off vendor dispatch by the scorer in the maintenance section.
// PLANNED, not shipped: the owner intends vendors to gain Autopilot too
// (2026-10-04). Add the claim here when the code can back it, not before, and
// see the planned-work note at the top of lib/inngest/functions/
// auto-assign-vendor.ts for what shipping it actually involves.
//
// Every figure here traces to a real constant. 157 catalog items and 24 asset
// types were counted live on 2026-10-03. The par buffer and three-count
// minimum come from lib/inventory/par-engine.ts. Nothing claims an hours-saved
// number, because there isn't one to claim.
// ============================================================================

const HEADER_LINKS = [
  { label: 'How it works', href: '/strops' },
  { label: 'Pricing',      href: '/pricing' },
  { label: 'Why FieldStay', href: '/why-fieldstay' },
] as const

const SERIF = 'var(--font-source-serif), Georgia, serif'
const SANS  = 'var(--font-archivo), Arial, sans-serif'

/** Booking platforms and systems shown in the credibility strip. */
const WORKS_WITH = [
  'Airbnb', 'VRBO', 'OwnerRez', 'Hospitable', 'Hostex', 'Hostaway', 'Lodgify', 'Stripe', 'Kroger',
] as const

/**
 * What each integration actually does, which is the detail a sceptic checks.
 * A grid of logos is the strip above; this is the substance under it.
 */
const INTEGRATIONS: ReadonlyArray<{ name: string; detail: string }> = [
  { name: 'OwnerRez',   detail: 'Two-way connection. Properties and bookings sync in, and guest reviews come across.' },
  { name: 'Hospitable', detail: 'Properties, bookings and teammates sync in. Guest messages are read into the timeline.' },
  { name: 'Hostex',     detail: 'Properties and bookings sync in, with webhooks for same-day changes.' },
  { name: 'Hostaway',   detail: 'Properties and bookings sync in, reconciled daily so a cancellation does not strand a turnover.' },
  { name: 'Lodgify',    detail: 'Properties and bookings sync in.' },
  { name: 'iCal',       detail: 'Airbnb, VRBO, Booking.com and direct calendars, for anything without a direct connection.' },
  { name: 'Stripe',     detail: 'Your subscription, and Connect payouts so vendors are paid from inside a work order.' },
  { name: 'Kroger',     detail: 'Below-par items can build a Kroger cart for pickup. FieldStay fills the cart, you place the order.' },
]

interface SectionProps {
  id: string
  kicker: string
  title: string
  body: string
  points?: readonly string[]
  children?: React.ReactNode
}

function Points({ points }: Readonly<{ points: readonly string[]; }>) {
  return (
    <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {points.map((p) => (
        <li key={p} style={{ display: 'flex', gap: 10, fontSize: 15, color: 'inherit' }}>
          <span aria-hidden="true" style={{ color: 'var(--mkt-gold)', fontWeight: 700 }}>&bull;</span>
          <span>{p}</span>
        </li>
      ))}
    </ul>
  )
}

function Copy({ kicker, title, body, points, tone }: Readonly<SectionProps & { tone: 'ink' | 'cream' }>) {
  const ink = tone === 'ink'
  return (
    <div style={{ maxWidth: 620 }}>
      <span
        className="text-xs font-bold uppercase"
        style={{ letterSpacing: '0.14em', color: ink ? 'var(--mkt-gold)' : 'var(--mkt-ed-muted)', fontFamily: SANS }}
      >
        {kicker}
      </span>
      <h2
        className="font-display font-semibold"
        style={{
          fontSize: 'clamp(25px, 3.6vw, 36px)', lineHeight: 1.12, letterSpacing: '-0.02em',
          color: ink ? '#FFFFFF' : 'var(--mkt-ed-ink)', margin: '12px 0 14px',
        }}
      >
        {title}
      </h2>
      <p style={{ fontFamily: SERIF, fontSize: 'clamp(17px, 2.3vw, 19px)', lineHeight: 1.6, margin: 0, color: ink ? 'var(--mkt-ed-on-ink)' : 'var(--mkt-ed-body)' }}>
        {body}
      </p>
      {points && (
        <div style={{ marginTop: 20, color: ink ? 'var(--mkt-ed-on-ink)' : 'var(--mkt-ed-body)', fontFamily: SANS }}>
          <Points points={points} />
        </div>
      )}
    </div>
  )
}

/** A navy "window" section. The emphasis treatment, alternating with cream. */
function InkSection(props: Readonly<SectionProps>) {
  return (
    <section
      id={props.id}
      className="rounded-[20px] sm:rounded-[28px]"
      style={{ background: 'var(--mkt-ed-ink)', padding: 'clamp(28px, 6vw, 56px) clamp(18px, 4.5vw, 56px)' }}
    >
      <Copy {...props} tone="ink" />
      {props.children && <div style={{ marginTop: 'clamp(26px, 4vw, 40px)' }}>{props.children}</div>}
    </section>
  )
}

/** A cream section, separated by the same hairline the sticky header uses. */
function CreamSection(props: Readonly<SectionProps>) {
  return (
    <section
      id={props.id}
      style={{ borderTop: '1px solid var(--mkt-ed-rule)', padding: 'clamp(32px, 5vw, 52px) clamp(2px, 2vw, 8px) clamp(8px, 2vw, 16px)' }}
    >
      <Copy {...props} tone="cream" />
      {props.children && <div style={{ marginTop: 'clamp(26px, 4vw, 40px)' }}>{props.children}</div>}
    </section>
  )
}

export function FeaturesContent() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--mkt-ed-bg)', color: 'var(--mkt-ed-ink)', fontFamily: SANS }}>
      <SiteHeader links={HEADER_LINKS} />

      <main style={{ maxWidth: 1180, margin: '0 auto', padding: 'clamp(44px, 8vw, 88px) clamp(16px, 3.5vw, 40px) clamp(64px, 10vw, 112px)' }}>
        <h1
          className="font-display font-semibold"
          style={{ fontSize: 'clamp(38px, 7vw, 62px)', lineHeight: 1.0, letterSpacing: '-0.03em', margin: '0 0 clamp(18px, 3vw, 26px)', maxWidth: 16 + 'ch' }}
        >
          Everything, included.
        </h1>
        <p style={{ fontFamily: SERIF, fontSize: 'clamp(19px, 3vw, 24px)', lineHeight: 1.5, color: 'var(--mkt-ed-ink)', margin: '0 0 clamp(16px, 3vw, 24px)', maxWidth: '34em' }}>
          Every feature below is in every plan. There is no tier where owner reports
          or maintenance scheduling or CapEx planning sit behind a bigger number, and
          no per user charge for the crew and vendors you invite.
        </p>

        {/* Borrowed credibility before any claim of our own. */}
        <div style={{ borderTop: '1px solid var(--mkt-ed-rule)', borderBottom: '1px solid var(--mkt-ed-rule)', padding: '18px 0', margin: 'clamp(28px, 5vw, 44px) 0 clamp(8px, 2vw, 16px)' }}>
          <div className="flex flex-wrap items-center" style={{ gap: '10px 22px' }}>
            <span className="text-xs font-bold uppercase" style={{ letterSpacing: '0.14em', color: 'var(--mkt-ed-muted)' }}>Works with</span>
            {WORKS_WITH.map((n) => (
              <span key={n} style={{ fontSize: 15, fontWeight: 600, color: 'var(--mkt-ed-body)' }}>{n}</span>
            ))}
          </div>
        </div>

        <div className="flex flex-col" style={{ gap: 'clamp(28px, 5vw, 48px)' }}>
          <CreamSection
            id="turnovers"
            kicker="Turnovers and crew"
            title="Every turnover in one place, sorted by what needs you."
            body="Bookings arrive from your PMS and your calendars, and the board sorts itself by urgency. Then you choose how much of the scheduling FieldStay does on its own. On Suggest it picks the best matched crew and shows you why, and you accept or change it. On Autopilot it assigns them and you never open the board at all. Off is a setting too, if you would rather do it yourself."
            points={[
              'Suggest: the best matched crew, with the reasoning shown',
              'Autopilot: assigned for you, hands off',
              'Same-day turnovers flagged before they bite',
              'One board across every property',
            ]}
          >
            <MockupScroller minWidth={1080}>
              <ManagersBoardMockup />
            </MockupScroller>
          </CreamSection>

          <InkSection
            id="crew"
            kicker="The crew's phone"
            title="Works in a basement with no signal."
            body="The crew app is local first. Checklists, photos and counts are written to the phone and sent when the signal comes back, in the order they happened. A cleaner in a lake house with one bar is not blocked, and nothing they did is lost."
            points={[
              'Photo checklists, room by room',
              'Required photos before an item can close',
              'Queued work uploads in order once back online',
            ]}
          >
            <div className="flex justify-center">
              <CrewChecklistMockup />
            </div>
          </InkSection>

          <CreamSection
            id="maintenance"
            kicker="Maintenance and vendors"
            title="Vendors get a link, not a login."
            body="A work order goes out with a not-to-exceed amount attached. The vendor opens a link, sees the job, adds line items and submits an invoice. No account, no password, no app. Compliance documents are tracked, and an expired certificate blocks assignment before it becomes your problem."
            points={[
              'Not-to-exceed set before the work starts',
              'Insurance and licence expiry tracked per vendor',
              'Paid through Stripe Connect from inside the work order',
            ]}
          >
            <MockupScroller minWidth={640}>
              <VendorInvoiceMockup />
            </MockupScroller>
          </CreamSection>

          <InkSection
            id="inventory"
            kicker="Inventory"
            title="Par levels that correct themselves."
            body="Start with 157 supplies already in the catalog across 10 categories, with par levels scaled to each property's bedrooms, baths and guest count. Then the counts take over. After three real counts an item re-derives its own par from what the property actually consumes, so the number stops being the guess somebody made on setup day."
            points={[
              'Below-par items build a purchase order automatically',
              'Or a Kroger cart for pickup, which you place',
              'Fractional counts, because half a case is a real number',
            ]}
          >
            <ParLevelChart />
          </InkSection>

          <CreamSection
            id="assets"
            kicker="Assets and CapEx"
            title="Know which roof is next before the owner asks."
            body="Every major asset carries a health score, a lifespan range and a replacement cost, drawn from 24 asset types. FieldStay turns that into a replacement forecast and a monthly reserve figure, so a capital conversation with an owner starts from a number rather than a feeling."
            points={[
              'Health scoring from age, work order history and warranty',
              'MACRS depreciation tracked per asset, per tax year',
              'Repair or replace guidance at the point of decision',
            ]}
          >
            <MockupScroller minWidth={700}>
              <OwnerCapexMockup />
            </MockupScroller>
          </CreamSection>

          <InkSection
            id="owners"
            kicker="Owner reporting"
            title="The owner statement writes itself."
            body="Owners get their own portal with a running profit and loss. Revenue arrives from the booking, the cleaning fee posts when the turnover completes, the maintenance expense posts when the work order closes. It is a by-product of the work rather than a spreadsheet you rebuild every month, and you control which lines the owner sees."
            points={[
              'Per property profit and loss, always current',
              'Each line traced to the job that created it',
              'Inspection reports and CapEx forecasts in the same portal',
            ]}
          />

          <CreamSection
            id="guests"
            kicker="Guests"
            title="A guidebook that pays for itself."
            body="Each property gets a guest guidebook with wifi, check-in details, house rules and local recommendations. Local businesses can sponsor a slot in it, and each sponsor takes five dollars a month off your bill. Guests who opt in can also get door codes and arrival details by text."
            points={[
              'Weather aware recommendations, no app to download',
              'Sponsor slots credit your subscription',
              'Guest texting requires opt-in, with the consent recorded',
            ]}
          >
            <div className="flex justify-center">
              <GuestGuidebookMockup />
            </div>
          </CreamSection>

          <InkSection
            id="integrations"
            kicker="Integrations"
            title="What actually syncs."
            body="Five property management systems connect directly, and anything else comes in by calendar. Here is exactly what each one moves, so you can check it against what you run today."
          >
            <dl style={{ margin: 0, display: 'grid', gap: 20 }}>
              {INTEGRATIONS.map((i) => (
                <div key={i.name}>
                  <dt style={{ fontSize: 15, fontWeight: 700, color: 'var(--mkt-gold)', fontFamily: SANS }}>{i.name}</dt>
                  <dd style={{ margin: '4px 0 0', fontSize: 15, lineHeight: 1.6, color: 'var(--mkt-ed-on-ink)', fontFamily: SANS }}>{i.detail}</dd>
                </div>
              ))}
            </dl>
          </InkSection>
        </div>

        <section
          className="rounded-[20px] sm:rounded-[28px]"
          style={{ background: 'var(--mkt-ed-ink)', padding: 'clamp(30px, 6vw, 52px) clamp(18px, 4.5vw, 56px)', marginTop: 'clamp(28px, 5vw, 48px)' }}
        >
          <h2 className="font-display font-semibold" style={{ fontSize: 'clamp(24px, 3.4vw, 34px)', lineHeight: 1.15, letterSpacing: '-0.02em', color: '#FFFFFF', margin: '0 0 12px' }}>
            All of it, from $19 a month.
          </h2>
          <p style={{ fontFamily: SERIF, fontSize: 'clamp(17px, 2.3vw, 19px)', lineHeight: 1.6, color: 'var(--mkt-ed-on-ink)', margin: '0 0 26px', maxWidth: '46em' }}>
            Your first property is $19, and the price per property drops as you add
            more. No contract, no setup fee, and no charge for the people you invite.
          </p>
          <div className="flex flex-col sm:flex-row sm:items-center" style={{ gap: 14 }}>
            <Link
              href="/signup"
              className="rounded-full text-center font-bold w-full sm:w-auto transition-colors hover:bg-[var(--mkt-gold-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mkt-ed-ink)] focus-visible:ring-[var(--mkt-gold)]"
              style={{ background: 'var(--mkt-gold)', color: 'var(--mkt-ed-ink)', padding: '17px 28px', fontSize: 16 }}
            >
              Start your free 14-day trial
            </Link>
            <Link
              href="/pricing"
              className="rounded-full text-center font-semibold w-full sm:w-auto transition-colors hover:text-[var(--mkt-gold-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mkt-ed-ink)] focus-visible:ring-[var(--mkt-gold)]"
              style={{ color: 'var(--mkt-gold)', padding: '17px 10px', fontSize: 16 }}
            >
              See the pricing calculator
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
