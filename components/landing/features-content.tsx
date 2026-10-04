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
// /features — the overview page. One long scrolling page, deliberately not
// tabbed: the homepage already owns the tabbed, role-filtered treatment, and
// this page's entire value is that it does NOT make a reader choose a role
// before seeing anything.
//
// ── THE EDITORIAL RULE: THREE SENTENCES, NO LISTS ──────────────────────────
//
// This page answers ONE question, and it is not "how does feature X work".
// It is "what do I get, and is any of it held back from me". So the frame is
// everything-in-every-plan, and each feature gets a 40,000-foot paragraph of
// about three sentences and then stops.
//
// The first version of this page carried a four-bullet list under every
// section plus a per-integration breakdown of exactly what each PMS moves,
// and the owner's verdict was that it was too granular to read. The bullets
// were not wrong, they were the wrong altitude for this page. If a mechanism
// genuinely needs explaining at length, it belongs on its own page where
// someone has chosen to go deeper, not stacked eight times on the overview.
//
// So: do not reintroduce a `points` list here, and do not grow a paragraph
// past about three sentences. A figure is allowed where it IS the claim (157
// catalog items, 24 asset types, $19, five dollars a sponsor) and every one
// of those traces to a real constant. Process detail is not.
//
// ── INTEGRATIONS ARE NOT ON THIS PAGE, BY DECISION ────────────────────────
//
// There was an Integrations section here, and a "Works with" strip of nine
// platform names under the hero. Both are gone: integrations get their own
// page (/integrations), and a list of the same names in two places is a second
// thing to keep true every time a connector ships or changes. Do not put
// either back. The one line pointing at that page, below the last feature, is
// what replaces them, and it carries no platform names for the same reason.
//
// DENSITY IS THE DESIGN for the VISUALS, which are what carries the page now
// that the prose is short. Three heavy desktop mockups, two phone-shaped
// ones, one chart, and one section with no visual at all. A page where every
// section weighs the same has no hierarchy and the reader stops partway down.
// Resist giving every feature a mockup: each one is also a permanent promise
// to keep it in step with the real surface it mirrors.
//
// ── The one claim that is easy to get wrong ────────────────────────────────
//
// Crew scheduling has THREE modes: Off, Suggest, Autopilot (organizations
// .auto_assign_mode, settings-tabs.tsx, lib/inngest/functions/auto-assign-
// turnover.ts). Autopilot really does insert the assignment with nobody in
// the loop. An earlier draft said assignment was "a suggestion you approve,
// never an assignment made over your head", which was both wrong and a worse
// sell than the truth. Vendors are NOT the same: vendor_auto_assign_mode is
// only 'suggest' or 'disabled', with no autopilot, so do not imply hands-off
// vendor dispatch by the scorer in the maintenance section. PLANNED, not
// shipped: the owner intends vendors to gain Autopilot too (2026-10-04). Add
// the claim here when the code can back it, not before, and see the
// planned-work note at the top of lib/inngest/functions/auto-assign-vendor.ts
// for what shipping it actually involves.
// ============================================================================

const HEADER_LINKS = [
  { label: 'How it works', href: '/strops' },
  { label: 'Pricing',      href: '/pricing' },
  { label: 'Why FieldStay', href: '/why-fieldstay' },
] as const

const SERIF = 'var(--font-source-serif), Georgia, serif'
const SANS  = 'var(--font-archivo), Arial, sans-serif'

interface SectionProps {
  id: string
  kicker: string
  title: string
  body: string
  children?: React.ReactNode
}

function Copy({ kicker, title, body, tone }: Readonly<SectionProps & { tone: 'ink' | 'cream' }>) {
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
          Every feature below is in every plan, whether you manage two properties or
          a hundred. There is no tier where owner reports or maintenance scheduling
          or CapEx planning sit behind a bigger number, and no per user charge for
          the crew and vendors you invite.
        </p>

        <div className="flex flex-col" style={{ gap: 'clamp(28px, 5vw, 48px)' }}>
          <CreamSection
            id="turnovers"
            kicker="Turnovers and crew"
            title="Every turnover in one place, sorted by what needs you."
            body="Bookings arrive from your PMS and your calendars, and the board sorts itself by what needs you first. You choose how much of the scheduling FieldStay does on its own: it can pick the best matched crew and show you why, or put the whole thing on Autopilot and assign them without asking. Same-day turnovers are flagged before they bite."
          >
            <MockupScroller minWidth={1080}>
              <ManagersBoardMockup />
            </MockupScroller>
          </CreamSection>

          <InkSection
            id="crew"
            kicker="The crew's phone"
            title="Works in a basement with no signal."
            body="The crew app is local first, so checklists, photos and counts are written to the phone and sent when the signal comes back. A cleaner in a lake house with one bar is never blocked, and nothing they did is lost. You can require a photo before an item closes, so the proof arrives with the work."
          >
            <div className="flex justify-center">
              <CrewChecklistMockup />
            </div>
          </InkSection>

          <CreamSection
            id="maintenance"
            kicker="Maintenance and vendors"
            title="Vendors get a link, not a login."
            body="A work order goes out with a not-to-exceed amount attached, and the vendor opens a link, sees the job and submits an invoice. No account, no password, nothing to install. Insurance and licence expiry are tracked per vendor, so an expired certificate blocks assignment before it becomes your problem."
          >
            <MockupScroller minWidth={640}>
              <VendorInvoiceMockup />
            </MockupScroller>
          </CreamSection>

          <InkSection
            id="inventory"
            kicker="Inventory"
            title="Par levels that correct themselves."
            body="You start with 157 supplies already in the catalog, with par levels scaled to each property's bedrooms, baths and guest count. Then the counts take over, and each item re-derives its own par from what that property actually consumes. Anything below par builds a purchase order, or a Kroger cart you place for pickup."
          >
            <ParLevelChart />
          </InkSection>

          <CreamSection
            id="assets"
            kicker="Assets and CapEx"
            title="Know which roof is next before the owner asks."
            body="Every major asset carries a health score, a lifespan range and a replacement cost, drawn from 24 asset types. FieldStay turns that into a replacement forecast and a monthly reserve figure. A capital conversation with an owner starts from a number rather than a feeling."
          >
            <MockupScroller minWidth={700}>
              <OwnerCapexMockup />
            </MockupScroller>
          </CreamSection>

          <InkSection
            id="owners"
            kicker="Owner reporting"
            title="The owner statement writes itself."
            body="Owners get their own portal with a running profit and loss, and every line traces back to the job that created it. Revenue posts from the booking, the cleaning fee when the turnover completes, the maintenance expense when the work order closes. It is a by-product of the work rather than a spreadsheet you rebuild every month, and you control which lines the owner sees."
          />

          <CreamSection
            id="guests"
            kicker="Guests"
            title="A guidebook that pays for itself."
            body="Each property gets a guest guidebook with wifi, check-in details, house rules and weather aware local recommendations, and there is nothing for the guest to download. Local businesses can sponsor a slot in it, and each sponsor takes five dollars a month off your bill. Guests who opt in can get door codes and arrival details by text."
          >
            <div className="flex justify-center">
              <GuestGuidebookMockup />
            </div>
          </CreamSection>
        </div>

        <p
          style={{
            fontFamily: SERIF, fontSize: 'clamp(17px, 2.3vw, 19px)', lineHeight: 1.6,
            color: 'var(--mkt-ed-body)', margin: 'clamp(30px, 5vw, 46px) 0 0', maxWidth: '40em',
          }}
        >
          Your reservations come in from your PMS or your calendars.{' '}
          <Link
            href="/integrations"
            className="underline transition-colors hover:text-[var(--mkt-ed-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mkt-ed-bg)] focus-visible:ring-[var(--mkt-gold)] rounded-sm"
            style={{ color: 'var(--mkt-ed-ink)', fontWeight: 600, textDecorationColor: 'var(--mkt-gold)', textUnderlineOffset: 3 }}
          >
            See everything FieldStay connects to
          </Link>
          .
        </p>

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
