import Link from 'next/link'
import { SiteHeader } from '@/components/landing/site-header'
import { SiteFooter } from '@/components/landing/site-footer'

// ============================================================================
// /why-fieldstay — the founder letter.
//
// The prose below is the owner's, supplied 2026-10-03 and kept VERBATIM at
// their explicit instruction, including the places where it reads as speech
// rather than marketing ("I assure you it's not", "it costs you nothing
// extra"). That voice is the point of the page: it is a first-person argument
// for trusting a new product, and smoothing it into house copy would remove
// the only thing the page has that a feature list does not. Do not tidy the
// grammar, tighten a sentence or split a long one without asking the owner.
//
// On the revenue-share paragraph, because the wording was questioned once and
// checked out: "The credits scale with your property count" is accurate. The
// RATE is flat, $5 per active sponsor per month from the first one
// (lib/guidebook/sponsor-economics.ts, CREDIT_PER_SPONSOR_CENTS = 500), but
// the sponsor COUNT is what scales. Slots are per-PROPERTY —
// guidebook_sponsor_assignments is keyed on property_id with a partial unique
// on (property_id, slot_type) — and the old per-org ceiling of 6 was dropped
// by 20260909234738_uncap_guidebook_sponsor_slots.sql, so slot inventory grows
// with the portfolio and the credit total grows with it. "Up to the entire
// bill" is the cap in resolvePlanCredit(), which floors the invoice at zero
// rather than letting credit run negative into a Stripe customer balance.
//
// If the $5 figure or that cap ever moves, this page is a place the old number
// would survive, because it is prose here rather than a derived value.
//
// Every other number here WAS verified against the code on 2026-10-03 and is
// correct: $19 / $13 / $10 and the brackets below them ($8 for 16 to 50, $6
// for 51 to 150) match BRACKETS in lib/stripe/brackets.ts; annual at two
// months free matches ANNUAL_MULTIPLIER = 10; nothing is feature-gated because
// there is one graduated price rather than tiers; and the inventory par levels
// really do re-derive from consumption history once enough counts exist
// (lib/inventory/par-engine.ts). They are PROSE here, not derived values, so
// a pricing change has to be mirrored by hand. /pricing computes from
// brackets.ts and is linked below for exactly that reason.
//
// The prose is DATA rather than JSX so the apostrophes survive as written,
// with no &apos; escaping to review and no chance of a character being
// silently normalised in a diff.
// ============================================================================

interface Section {
  /** Omitted for the setup passage and the sign-off, which the owner supplied without one. */
  heading?: string
  /** A navy "window" or a cream passage. See LAYOUT below for why they alternate. */
  tone: 'ink' | 'cream'
  paragraphs: readonly string[]
}

// ── LAYOUT ──────────────────────────────────────────────────────────────────
//
// The owner asked for a cream page with the text inside brand-blue windows.
// The first build took that literally and put all six passages in navy panels,
// which inverted the brief: three quarters of the page became ink, so it read
// as a navy page with cream gutters, and a dark panel used six times running
// stops being emphasis and becomes wallpaper. Six identical panels also gave a
// one-sentence passage exactly the weight of the four-paragraph pricing one.
//
// So the windows ALTERNATE. Three navy, two cream, and the opening thesis
// lifted out as a standfirst under the h1. Navy means something again, the
// page is the cream surface that was asked for, and ~6,000 characters of
// first-person argument are no longer all set in reverse contrast, which is
// tiring to read however well it measures for contrast ratio.
//
// The ORDER of the passages is the owner's and is unchanged. Only their
// treatment alternates.
// ────────────────────────────────────────────────────────────────────────────

/** The opening thesis. Set as a cream standfirst under the h1, not as a panel. */
const STANDFIRST =
  "Why take a risk on a new to market software product that will serve as the core backbone of your operations? It's admittedly a big ask, but it is one I make with complete confidence. FieldStay is new, and it was built with high intentionality by someone who spent a career in operations and logistics before writing a line of it. It was not designed by committee or researched from the outside. It was built from the work."

const SECTIONS: readonly Section[] = [
  {
    heading: 'Who we answer to',
    tone: 'ink',
    paragraphs: [
      'FieldStay is not backed by venture capital or private equity money. The most important voice to us is the people using the product. That is why even the crew app has a feedback form in it. Our entire mission statement is simply to make your day less stressful. We want to know what you need added or changed.',
      'For competitors backed by VC or private equity, the most important voices are ultimately the people providing the money. Many of them provide excellent service. That does not change who they answer to when the two are in conflict.',
    ],
  },
  {
    heading: 'What us being small gets you',
    tone: 'cream',
    paragraphs: [
      'When you ask for something, it goes to the person who can build it, and it gets built. There is no roadmap committee and no quarter to wait for.',
      // "because that is the only person here" was removed 2026-10-05, when /about
      // introduced Bryan as a co-founder. Everything else in this paragraph is
      // still literally true and is deliberately untouched: Stephen writes all
      // of the code, so you DO get the person who built it, and there is still
      // no support tier to be bounced through. Only the headcount claim was
      // false, so only the headcount claim went. The rest is the owner's
      // prose, and the rule at the top of this file still applies to it.
      'When something breaks, you are not bounced around until somebody finds the right person. There is nobody to bounce you to. You get the person who built it.',
      'I will not always be able to say that. Right now it is true, and while it is true you get the benefit of it.',
    ],
  },
  {
    heading: 'What it costs to find out',
    tone: 'ink',
    paragraphs: [
      'Our pricing is transparent, published with a pricing calculator, and is the same for everyone. Your first property is $19 a month, $13 each for properties two through four, $10 each for five through fifteen, and it keeps dropping from there.',
      "Every feature is included in every plan. There is no tier where owner reports or maintenance scheduling or CapEx planning sit behind a bigger plan. We wanted to give users a complete product from day one which is why we don't feature-gate anything and we don't nickel and dime you with add-on features.",
      'You never have to sign a contract to use FieldStay. There is no setup fee, no onboarding fee, and no per user charge. Invite your cleaners, maintenance team, lawncare crew and add your vendors, it costs you nothing extra. Pay month to month for your plan, or annually and get two months free, you can cancel whenever.',
      "The other cost for someone using FieldStay is not what you would expect. We have a revenue-share feature built directly into the platform. Revenue share might sound like a marketing ploy to some, but I assure you it's not. It is very straightforward and a win-win-win for everyone. Here is exactly how it works. The guest guidebook has local sponsorship slots. Restaurants, outfitters, whoever is near your properties pays to be in front of your guests as a suggested place to eat or get coffee or some sort of outdoor activity with a coupon to use if they choose to include one. Each business that is paying monthly to be a sponsor gives you a $5 credit against your bill every month. The credits scale with your property count while the per property price drops, so the more you grow the more of the bill it can cover, up to the entire bill.",
    ],
  },
  {
    tone: 'cream',
    paragraphs: [
      "Setup is very simple, it's an onboarding wizard that walks you through each step. Connect your PMS, your properties come over automatically, invite your crew. The turnover checklists are already built out by room and we have customized specialty templates or you can build templates as well. The property inventories have par levels preloaded that adjust themselves over time, so you are not starting from a blank screen.",
    ],
  },
  {
    tone: 'ink',
    paragraphs: [
      "If you are wrong about us or if it's just not a good fit you simply cancel. I may ask what we could have done differently, but then we will make sure the transition off FieldStay is as smooth and painless as possible.",
    ],
  },
]

const HEADER_LINKS = [
  { label: 'How it works', href: '/strops' },
  { label: 'Pricing',      href: '/pricing' },
  { label: 'vs Breezeway', href: '/breezeway-alternative' },
] as const

const SERIF = 'var(--font-source-serif), Georgia, serif'
const SANS  = 'var(--font-archivo), Arial, sans-serif'

/**
 * The letter is set in the SERIF, not in Archivo.
 *
 * A text serif is what makes a long first-person argument read as
 * correspondence rather than as marketing, which is the warm register this
 * page was asked for. Headings stay on font-display (Inter) so they match the
 * homepage's; moving those to the serif is a decision for both pages at once.
 */
const proseStyle = (tone: Section['tone']): React.CSSProperties => ({
  fontFamily: SERIF,
  fontSize:   'clamp(17px, 2.4vw, 19px)',
  lineHeight: 1.65,
  color:      tone === 'ink' ? 'var(--mkt-ed-on-ink)' : 'var(--mkt-ed-body)',
  margin:     0,
})

/**
 * Paragraph separation is a flex GAP, never a bottom margin on each <p>.
 *
 * A margin applies to the last paragraph too, which left every panel with a
 * band of dead space under its final line and padding that measured visibly
 * asymmetric. The gap is also sized ABOVE the line box (19px x 1.65 = 31px):
 * the first version used 18px against that same 31px box, so paragraphs were
 * separated by less than their own leading and did not read as separate.
 */
const PARAGRAPH_GAP = 'clamp(22px, 3vw, 28px)'

function Paragraphs({ section }: Readonly<{ section: Section }>) {
  return (
    <div className="flex flex-col" style={{ gap: PARAGRAPH_GAP }}>
      {section.paragraphs.map((text) => (
        <p key={text.slice(0, 48)} style={proseStyle(section.tone)}>{text}</p>
      ))}
    </div>
  )
}

function Heading({ children, tone }: Readonly<{ children: string; tone: Section['tone'] }>) {
  return (
    <h2
      className="font-display font-semibold"
      style={{
        fontSize:      'clamp(25px, 3.6vw, 34px)',
        lineHeight:    1.15,
        letterSpacing: '-0.02em',
        // White on navy, navy on cream. Gold is deliberately NOT a heading
        // colour: on the homepage gold means eyebrow, metric or button fill,
        // and a heading on navy there is white. Spending gold on headings here
        // both contradicted that and used up a hierarchy step the page needs.
        color:  tone === 'ink' ? '#FFFFFF' : 'var(--mkt-ed-ink)',
        margin: `0 0 clamp(18px, 3vw, 26px)`,
      }}
    >
      {children}
    </h2>
  )
}

/** A navy "window": the emphasis treatment, used for three of the five passages. */
function InkWindow({ section, children }: Readonly<{ section: Section; children?: React.ReactNode }>) {
  return (
    <article
      // Radius drops below sm: 28px on a ~350px block pinches the corners of
      // the text column.
      className="rounded-[20px] sm:rounded-[28px]"
      style={{
        background: 'var(--mkt-ed-ink)',
        padding:    'clamp(26px, 6vw, 52px) clamp(18px, 4.5vw, 56px)',
      }}
    >
      {section.heading && <Heading tone="ink">{section.heading}</Heading>}
      <Paragraphs section={section} />
      {children}
    </article>
  )
}

/** A cream passage, separated by the same hairline the sticky header uses. */
function CreamPassage({ section }: Readonly<{ section: Section }>) {
  return (
    <article
      style={{
        borderTop: '1px solid var(--mkt-ed-rule)',
        padding:   'clamp(30px, 5vw, 48px) clamp(2px, 2vw, 8px) clamp(6px, 2vw, 12px)',
      }}
    >
      {section.heading && <Heading tone="cream">{section.heading}</Heading>}
      <Paragraphs section={section} />
    </article>
  )
}

/**
 * The sign-off.
 *
 * The letter is first-person from its first sentence ("it is one I make with
 * complete confidence") to its last ("I may ask what we could have done
 * differently"), and until this was added nobody signed it, which is the one
 * thing a page arguing for trust cannot leave out.
 *
 * The name and role are NOT new strings: they are the homepage founder note's,
 * byte for byte, so the site signs itself one way rather than two. If that
 * note's attribution changes, change it here in the same sitting.
 */
function Signature() {
  return (
    <p
      style={{
        fontFamily: SANS,
        fontSize:   16,
        color:      'var(--mkt-ed-on-ink-soft)',
        margin:     'clamp(26px, 4vw, 36px) 0 0',
      }}
    >
      <strong style={{ color: '#FFFFFF' }}>Stephen</strong>
      {' \u00b7 Founder, Dadeville, Alabama'}
    </p>
  )
}

/**
 * The closing call to action, INSIDE the final navy window.
 *
 * It used to sit on the cream below the last panel, where the gold pill
 * measured 1.38:1 against the page: no perceptible edge, and short of the 3:1
 * WCAG asks of a control boundary, with all of its legibility coming from the
 * ink text inside it. On navy the same gold is 10.66:1 and the pill reads as an
 * object. It also attaches the buttons to the letter's last line instead of
 * leaving them floating, and it stacks cleanly at 390px.
 */
function ClosingActions() {
  const shared = 'rounded-full text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mkt-ed-ink)] focus-visible:ring-[var(--mkt-gold)]'
  return (
    <div className="flex flex-col sm:flex-row sm:items-center" style={{ gap: 14, marginTop: 'clamp(28px, 5vw, 40px)' }}>
      <Link
        href="/signup"
        className={`${shared} font-bold w-full sm:w-auto transition-colors hover:bg-[var(--mkt-gold-hover)]`}
        style={{ background: 'var(--mkt-gold)', color: 'var(--mkt-ed-ink)', padding: '17px 28px', fontSize: 16, fontFamily: SANS }}
      >
        Start your free 14-day trial
      </Link>
      <Link
        href="/pricing"
        className={`${shared} font-semibold w-full sm:w-auto transition-colors hover:text-[var(--mkt-gold-hover)]`}
        style={{ color: 'var(--mkt-gold)', padding: '17px 10px', fontSize: 16, fontFamily: SANS }}
      >
        See the pricing calculator
      </Link>
    </div>
  )
}

export function WhyFieldStayContent() {
  const lastIndex = SECTIONS.length - 1

  return (
    <div
      className="min-h-screen"
      style={{ background: 'var(--mkt-ed-bg)', color: 'var(--mkt-ed-ink)', fontFamily: SANS }}
    >
      <SiteHeader links={HEADER_LINKS} />

      <main style={{ maxWidth: 780, margin: '0 auto', padding: 'clamp(48px, 9vw, 96px) clamp(16px, 3.5vw, 40px) clamp(72px, 11vw, 120px)' }}>
        <h1
          className="font-display font-semibold"
          style={{
            // Floors and caps BELOW the homepage h1 (40px/72px): a secondary
            // page should not shout louder than the front door. Tracking is a
            // ratio rather than a flat -2.5px, which was -5.7% at the old 44px
            // floor and far too tight for that size.
            fontSize:      'clamp(38px, 7vw, 62px)',
            lineHeight:    1.0,
            letterSpacing: '-0.03em',
            color:         'var(--mkt-ed-ink)',
            margin:        '0 0 clamp(20px, 3vw, 28px)',
          }}
        >
          Why FieldStay
        </h1>

        {/* The opening thesis, set as the standfirst it reads as. In a panel it
            was separated from its own headline by a hard colour edge. */}
        <p
          style={{
            fontFamily: SERIF,
            fontSize:   'clamp(20px, 3vw, 25px)',
            lineHeight: 1.5,
            color:      'var(--mkt-ed-ink)',
            margin:     '0 0 clamp(40px, 7vw, 64px)',
            maxWidth:   '34em',
          }}
        >
          {STANDFIRST}
        </p>

        <div className="flex flex-col" style={{ gap: 'clamp(28px, 5vw, 48px)' }}>
          {SECTIONS.map((section, i) => {
            const key = section.heading ?? section.paragraphs[0].slice(0, 48)
            if (section.tone === 'cream') return <CreamPassage key={key} section={section} />
            return (
              <InkWindow key={key} section={section}>
                {i === lastIndex && <Signature />}
                {i === lastIndex && <ClosingActions />}
              </InkWindow>
            )
          })}
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
