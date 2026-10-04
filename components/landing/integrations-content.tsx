import Link from 'next/link'
import { SiteHeader } from '@/components/landing/site-header'
import { SiteFooter } from '@/components/landing/site-footer'

// ============================================================================
// /integrations — the roster page. The owner wrote this copy; what follows is
// the record of the three places it was adjusted and why, because each change
// is a factual claim on a public page rather than a styling preference.
//
// ── 1. "Guest financial information" became "payment details" ─────────────
//
// The draft said "We never sync or store any guest financial information."
// Two thirds of that is true and the middle third is not. We store NO payment
// instrument data at all: there is no card number, last4, payment method,
// billing address or bank detail anywhere in the schema or in any provider
// mapper. But bookings.actual_total_amount IS synced, by all five adapters
// (hospitable/hostex/hostaway/lodgify.mappers.ts, ownerrez.ts), and
// booking-events.ts posts it to owner_transactions as booking_revenue — which
// is the whole reason the owner P&L has a revenue line. A guest's stay total
// is guest financial information on any ordinary reading, so the sentence as
// drafted was contradicted by a feature we advertise one page over.
//
// The narrower claim is also the stronger one, so nothing was lost: "we never
// receive a card number" is specific and verifiable, where "no financial
// information" invites exactly one follow-up question we would have to walk
// back. If a payment-instrument field is ever added anywhere, this paragraph
// is wrong and has to change in the same commit.
//
// ── 2. Telnyx covers crew and vendors too, not only the guidebook ─────────
//
// The draft scoped Telnyx to "our guest guidebook SMS messaging feature". It
// is also how crew get assignment and cancellation texts, and how vendors are
// notified of a work order (crew-assignment.ts, crew-turnover-cancelled.ts,
// work-order-vendor-assigned.ts, work-order-public.ts, settings/actions.ts's
// crew invite). Understating this is a known-expensive mistake here: CLAUDE
// .md records a customer email drafted twice claiming crew invites arrive by
// email only, when inviteCrewMember also texts anyone with a phone on file.
// A reader deciding whether their crew will get texts must not be told SMS is
// a guest feature.
//
// ── 3. Hospitable is listed with the four others, not promoted ────────────
//
// public/hospitable-fieldstay-lockup.png exists, and it is the ONLY
// third-party brand asset in the repo. It is a co-marketing lockup, not a
// logo for a roster, and using it here would read as a preferred partner
// while the other four are plain text. Everything is text, which is also the
// safer trademark posture.
//
// ── Still open, from the 2026-10-04 design review ────────────────────────
//
// The PMS block would be the natural one to put in the ink treatment now that
// it is first, which would give the page an alternation its three cream blocks
// currently lack. The `#planned` panel's markup is the thing to factor out for
// it, rather than writing a second copy of that treatment inline.
//
// ── Keeping this page true ────────────────────────────────────────────────
//
// The five live ids are PMS_PROVIDER_IDS in lib/integrations/registry.ts, and
// a provider is live only when its integration_providers row has is_active =
// true. Guesty has a row with is_active = false and a commented-out adapter
// import; Uplisting has no row and no adapter, only vestigial references (an
// unused Inngest event name and the uplisting_booking transaction source). So
// both are honestly "coming soon" and neither may be described as connected.
// Verified against the live database on 2026-10-04.
// ============================================================================

const HEADER_LINKS = [
  { label: 'Features',     href: '/features' },
  { label: 'Pricing',      href: '/pricing' },
  { label: 'Why FieldStay', href: '/why-fieldstay' },
] as const

const SERIF = 'var(--font-source-serif), Georgia, serif'
const SANS  = 'var(--font-archivo), Arial, sans-serif'

interface Block {
  id: string
  /** The small uppercase eyebrow. A category, not a heading. */
  kicker: string
  /**
   * The real <h2>. Written for search rather than for cleverness: the query
   * this page has to win is some phrasing of "does FieldStay work with my
   * property management system", so the heading says that in those words and
   * stops. The kicker above it stays short so the two do not read as the same
   * line twice.
   */
  title: string
  body: string
  /** Rendered as the name row under the copy. Text, never logos: see header. */
  names: readonly string[]
}

/**
 * PMS FIRST, and the order is the argument.
 *
 * This was payments, messaging, PMS, which put "does it connect to the system
 * I already run" below two paragraphs about our card processor and our mail
 * vendor. Nobody evaluates FieldStay on which payment provider it uses: Stripe
 * and Resend are infrastructure disclosures a sceptic checks second, where the
 * PMS block is the question the page exists to answer, and it also carries the
 * guest-payment-details claim and six of the eight names.
 */
const CURRENT: readonly Block[] = [
  {
    id: 'pms',
    kicker: 'Reservations',
    title: 'Works with your property management system.',
    body: 'FieldStay currently connects to five PMS platforms as well as iCal to pull reservations for our core turnover feature. Additional information is also synced from PMS platforms for our other features. We never receive or store guest payment details: no card numbers, no payment methods, no billing addresses.',
    names: ['OwnerRez', 'Hospitable', 'Hostex', 'Hostaway', 'Lodgify', 'iCal'],
  },
  {
    id: 'messaging',
    kicker: 'Email and messaging',
    title: 'How we send email and text messages.',
    body: "All of our emails to client accounts are sent using Resend's email automation services. Our text messaging runs on Telnyx, for guidebook messages to guests who opt in and for the assignment and work order notices your crew and vendors receive.",
    names: ['Resend', 'Telnyx'],
  },
  {
    id: 'payments',
    kicker: 'Payments',
    title: 'How payments and vendor payouts work.',
    body: 'FieldStay uses Stripe to process payments for all plan subscriptions. We use Stripe Connect for all vendor invoice payments.',
    names: ['Stripe', 'Stripe Connect'],
  },
]

const COMING_SOON = ['Guesty', 'Uplisting'] as const

/** The name row. Plain type, sized to read as a roster rather than a logo wall. */
function Names({ names, tone }: Readonly<{ names: readonly string[]; tone: 'ink' | 'cream' }>) {
  const ink = tone === 'ink'
  return (
    <ul
      className="flex flex-wrap"
      style={{ listStyle: 'none', margin: '22px 0 0', padding: 0, gap: '10px 10px' }}
    >
      {names.map((n) => (
        <li
          key={n}
          className="rounded-full"
          style={{
            fontFamily:  SANS,
            fontSize:    15,
            fontWeight:  600,
            padding:     '8px 16px',
            color:       ink ? 'var(--mkt-gold)' : 'var(--mkt-ed-ink)',
            border:      `1px solid ${ink ? 'var(--mkt-gold)' : 'var(--mkt-ed-rule)'}`,
            background:  ink ? 'transparent' : 'var(--mkt-ed-bg-alt)',
          }}
        >
          {n}
        </li>
      ))}
    </ul>
  )
}

function CurrentBlock({ block }: Readonly<{ block: Block }>) {
  return (
    <section
      id={block.id}
      style={{ borderTop: '1px solid var(--mkt-ed-rule)', padding: 'clamp(28px, 4.5vw, 44px) 0 clamp(6px, 1.5vw, 12px)' }}
    >
      <span
        className="text-xs font-bold uppercase"
        style={{ letterSpacing: '0.14em', color: 'var(--mkt-ed-muted)', fontFamily: SANS }}
      >
        {block.kicker}
      </span>
      {/* A REAL h2, not a styled span. The page used to label these blocks with
          the kicker alone, which left the whole heading outline at h1 plus the
          one h2 on the planned-integrations panel: a screen reader could not
          jump to this section, the browser's own find-and-skim had nothing to
          catch, and the heading most worth ranking for was invisible as
          structure. Same treatment as features-content.tsx's Copy, so the two
          pages read as one site. */}
      <h2
        className="font-display font-semibold"
        style={{
          fontSize: 'clamp(25px, 3.6vw, 36px)', lineHeight: 1.12, letterSpacing: '-0.02em',
          color: 'var(--mkt-ed-ink)', margin: '12px 0 14px',
        }}
      >
        {block.title}
      </h2>
      <p
        style={{
          fontFamily: SERIF, fontSize: 'clamp(17px, 2.3vw, 20px)', lineHeight: 1.6,
          color: 'var(--mkt-ed-body)', margin: 0, maxWidth: '40em',
        }}
      >
        {block.body}
      </p>
      <Names names={block.names} tone="cream" />
    </section>
  )
}

export function IntegrationsContent() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--mkt-ed-bg)', color: 'var(--mkt-ed-ink)', fontFamily: SANS }}>
      <SiteHeader links={HEADER_LINKS} />

      <main style={{ maxWidth: 940, margin: '0 auto', padding: 'clamp(44px, 8vw, 88px) clamp(16px, 3.5vw, 40px) clamp(64px, 10vw, 112px)' }}>
        <h1
          className="font-display font-semibold"
          style={{ fontSize: 'clamp(38px, 7vw, 62px)', lineHeight: 1.0, letterSpacing: '-0.03em', margin: '0 0 clamp(18px, 3vw, 26px)', maxWidth: '14ch' }}
        >
          Current connections.
        </h1>
        <p style={{ fontFamily: SERIF, fontSize: 'clamp(19px, 3vw, 24px)', lineHeight: 1.5, margin: '0 0 clamp(20px, 4vw, 32px)', maxWidth: '32em' }}>
          What FieldStay plugs into today, and what each one is actually for.
        </p>

        {CURRENT.map((b) => (
          <CurrentBlock key={b.id} block={b} />
        ))}

        <section
          id="planned"
          className="rounded-[20px] sm:rounded-[28px]"
          style={{ background: 'var(--mkt-ed-ink)', padding: 'clamp(30px, 6vw, 52px) clamp(18px, 4.5vw, 52px)', marginTop: 'clamp(36px, 6vw, 60px)' }}
        >
          <h2
            className="font-display font-semibold"
            style={{ fontSize: 'clamp(25px, 3.6vw, 36px)', lineHeight: 1.12, letterSpacing: '-0.02em', color: '#FFFFFF', margin: '0 0 14px' }}
          >
            Future planned integrations.
          </h2>
          <p style={{ fontFamily: SERIF, fontSize: 'clamp(17px, 2.3vw, 20px)', lineHeight: 1.6, color: 'var(--mkt-ed-on-ink)', margin: 0, maxWidth: '40em' }}>
            We would love to be able to make everyone&rsquo;s day less stressful. That is
            why we are always looking to add more PMS connections and other partners
            that will benefit your operations.
          </p>

          <span
            className="text-xs font-bold uppercase"
            style={{ letterSpacing: '0.14em', color: 'var(--mkt-gold)', fontFamily: SANS, display: 'block', marginTop: 30 }}
          >
            Coming soon
          </span>
          <Names names={COMING_SOON} tone="ink" />
        </section>

        {/* NAVY, not cream, and that is a contrast fix rather than a rhythm
            choice. The gold fill on --mkt-gold against the page cream measures
            1.38:1, so the button's own edge was below the 3:1 WCAG 1.4.11 asks
            of a control boundary: the LABEL was legible and the thing did not
            read as a button. The identical fill on --mkt-ed-ink is 10.66:1,
            which is why /features and /why-fieldstay both put this pair inside
            an ink panel. This page was the only one to try it on cream.

            "See every feature" is OUTLINED rather than filled or bare. A
            second filled gold button competes with the trial CTA for the one
            click that matters; bare muted text on cream, which is what this
            was, reads as disabled. A gold border gives it a real edge and a
            real hit target while staying visibly secondary. The two sibling
            pages use bare gold text here, so this is a deliberate half-step
            ahead of them, worth rolling back to them if it reads well. */}
        <section
          className="rounded-[20px] sm:rounded-[28px]"
          style={{ background: 'var(--mkt-ed-ink)', padding: 'clamp(30px, 6vw, 52px) clamp(18px, 4.5vw, 52px)', marginTop: 'clamp(36px, 6vw, 60px)' }}
        >
          <p style={{ fontFamily: SERIF, fontSize: 'clamp(17px, 2.3vw, 20px)', lineHeight: 1.6, color: 'var(--mkt-ed-on-ink)', margin: '0 0 22px', maxWidth: '38em' }}>
            Running something that is not on this list? Your calendars will still come
            in by iCal, and{' '}
            {/* The invitation now has a mechanism. It previously said we would
                like to hear which system you use and then offered a trial
                button, so the only contact route was the address in the
                footer. Same address as the footer deliberately: one inbox. */}
            <a
              href="mailto:hello@fieldstay.app?subject=PMS%20integration%20request"
              className="underline rounded-sm transition-colors hover:text-[var(--mkt-gold-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mkt-ed-ink)] focus-visible:ring-[var(--mkt-gold)]"
              style={{ color: 'var(--mkt-gold)', fontWeight: 600, textUnderlineOffset: 3 }}
            >
              we would like to hear which system you use
            </a>
            .
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
              href="/features"
              className="rounded-full text-center font-semibold w-full sm:w-auto transition-colors hover:border-[var(--mkt-gold-hover)] hover:text-[var(--mkt-gold-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mkt-ed-ink)] focus-visible:ring-[var(--mkt-gold)]"
              style={{ color: 'var(--mkt-gold)', border: '1px solid var(--mkt-gold)', padding: '16px 26px', fontSize: 16 }}
            >
              See every feature
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
