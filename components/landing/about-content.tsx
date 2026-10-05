import Link from 'next/link'
import { SiteHeader } from '@/components/landing/site-header'
import { SiteFooter } from '@/components/landing/site-footer'

// ============================================================================
// /about — who builds FieldStay. The owner's copy, verbatim.
//
// ── ⚠ THIS PAGE CONTRADICTS TWO LIVE PAGES, AND THAT IS NOT YET RESOLVED ──
//
// This page says FieldStay is "built by two people", Stephen and Bryan, out of
// Camp Hill. The site already says, in copy a prospect reads in the same
// session:
//
//   why-fieldstay-content.tsx:91  "You get the person who built it, because
//                                  that is the only person here."
//   why-fieldstay-content.tsx     signed "Stephen · Founder, Dadeville, Alabama"
//   homepage-content.tsx          the founder note, first-person singular
//                                 throughout ("I spent my career", "I built
//                                 FieldStay"), signed the same way
//   app/why-fieldstay/page.tsx    metadata, twice: "the person who built it"
//
// The headcount conflict is the sharp one: "the only person here" and "two
// people" cannot both be true, and it sits on the page whose entire argument
// is that this company tells you the truth about itself. The town differs too,
// Camp Hill against Dadeville.
//
// This was raised with the owner rather than fixed here, because the founder
// letter and the homepage note are his personal voice and his signature, and
// rewriting a first-person letter into first-person plural is his call and not
// a copy edit. Until he decides, /about is the page that is out of step with
// the other two, not the other way round.
//
// ── Structure ────────────────────────────────────────────────────────────
//
// Cream and ink alternate, same as why-fieldstay-content.tsx and
// features-content.tsx. "Who we answer to" and "What's next" take the ink,
// because those two are the promises a sceptic is actually weighing: who
// decides what gets built, and what happens when I call. "Where we are" stays
// cream even though it is the most charming section, since its job is to
// explain the offline-first decision rather than to carry the argument.
// ============================================================================

const HEADER_LINKS = [
  { label: 'Features',     href: '/features' },
  { label: 'Pricing',      href: '/pricing' },
  { label: 'Why FieldStay', href: '/why-fieldstay' },
] as const

const SERIF = 'var(--font-source-serif), Georgia, serif'
const SANS  = 'var(--font-archivo), Arial, sans-serif'

interface Section {
  id: string
  title: string
  /** One entry per rendered paragraph. The owner's copy, unedited. */
  paragraphs: readonly string[]
  tone: 'ink' | 'cream'
}

const SECTIONS: readonly Section[] = [
  {
    id: 'why',
    title: 'Why we started it',
    tone: 'cream',
    paragraphs: [
      'We started FieldStay because we thought there was a better way to do software for short-term rental operations. Software doesn’t have to nickel and dime you with add-ons or be gated behind a higher tier plan than what you use.',
      'Our mission is simple enough to fit on one line. Make your day less stressful. Every decision about what goes into the product gets measured against that. Software shouldn’t be complicated. It should be effective and make you efficient. That means sometimes less is more.',
    ],
  },
  {
    id: 'who-we-answer-to',
    title: 'Who we answer to',
    tone: 'ink',
    paragraphs: [
      'The people who use FieldStay are the ones we answer to. When a property manager tells us a checklist is missing a field, or that the crew app needs to behave differently when a phone has no signal, that goes on the list and it gets built. We are small, and small means we can move on what you ask for instead of putting it in a queue behind a hundred other accounts and a committee or boardroom.',
      'We also try to be straight with people about what the product does and does not do today. If you ask whether FieldStay handles something and it does not, you will get a no instead of a maybe. That matters more to us than closing a deal.',
    ],
  },
  {
    id: 'where',
    title: 'Where we are',
    tone: 'cream',
    paragraphs: [
      'We operate FieldStay out of Camp Hill, Alabama, just 15 minutes away from Auburn University and 10 minutes from Lake Martin. Definitely rural. Our location is part of why the crew app and the vendor portal are built offline first. Out here, cell service is not a given, and we built for the places where it drops because that is where we live and where some of the best vacation places in the country happen to be as well.',
    ],
  },
  {
    id: 'whats-next',
    title: 'What’s next',
    tone: 'ink',
    paragraphs: [
      'We are early. We would rather tell you that than pretend otherwise. What that means for you is that you can shape what this becomes, and you can get a founder on the phone instead of a ticket number or bounced from person to person.',
    ],
  },
]

/**
 * The ink panel. One definition for every navy surface on the page, the same
 * reason integrations-content.tsx has one: the treatment gets written inline
 * twice and then a radius or a padding quietly stops matching.
 */
function InkPanel({ id, children }: Readonly<{ id?: string; children: React.ReactNode }>) {
  return (
    <section
      id={id}
      className="rounded-[20px] sm:rounded-[28px]"
      style={{ background: 'var(--mkt-ed-ink)', padding: 'clamp(28px, 6vw, 56px) clamp(18px, 4.5vw, 56px)' }}
    >
      {children}
    </section>
  )
}

function SectionCopy({ section }: Readonly<{ section: Section }>) {
  const ink = section.tone === 'ink'
  return (
    <>
      <h2
        className="font-display font-semibold"
        style={{
          fontSize: 'clamp(25px, 3.6vw, 36px)', lineHeight: 1.12, letterSpacing: '-0.02em',
          color: ink ? 'var(--mkt-ed-on-ink-strong)' : 'var(--mkt-ed-ink)', margin: '0 0 16px',
        }}
      >
        {section.title}
      </h2>
      {section.paragraphs.map((text) => (
        <p
          key={text.slice(0, 48)}
          style={{
            fontFamily: SERIF, fontSize: 'clamp(17px, 2.3vw, 20px)', lineHeight: 1.65,
            color: ink ? 'var(--mkt-ed-on-ink)' : 'var(--mkt-ed-body)',
            margin: '0 0 18px', maxWidth: '40em',
          }}
        >
          {text}
        </p>
      ))}
    </>
  )
}

function SectionBlock({ section }: Readonly<{ section: Section }>) {
  if (section.tone === 'ink') {
    // No hairline: the panel's own edge is the separation, and a rule running
    // into a rounded corner reads as a mistake.
    return (
      <div style={{ margin: 'clamp(30px, 5vw, 52px) 0' }}>
        <InkPanel id={section.id}><SectionCopy section={section} /></InkPanel>
      </div>
    )
  }
  return (
    <section
      id={section.id}
      style={{ borderTop: '1px solid var(--mkt-ed-rule)', padding: 'clamp(30px, 5vw, 50px) 0 clamp(8px, 2vw, 14px)' }}
    >
      <SectionCopy section={section} />
    </section>
  )
}

export function AboutContent() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--mkt-ed-bg)', color: 'var(--mkt-ed-ink)', fontFamily: SANS }}>
      <SiteHeader links={HEADER_LINKS} />

      <main style={{ maxWidth: 900, margin: '0 auto', padding: 'clamp(44px, 8vw, 88px) clamp(16px, 3.5vw, 40px) clamp(64px, 10vw, 112px)' }}>
        <h1
          className="font-display font-semibold"
          style={{ fontSize: 'clamp(36px, 6.4vw, 58px)', lineHeight: 1.04, letterSpacing: '-0.03em', margin: '0 0 clamp(20px, 3vw, 28px)', maxWidth: '20ch' }}
        >
          We came from operations, not software
        </h1>

        {/* The standfirst is set larger than the body that follows it, which is
            what makes the first line read as a claim rather than as paragraph
            one of five. */}
        <p style={{ fontFamily: SERIF, fontSize: 'clamp(19px, 3vw, 24px)', lineHeight: 1.5, margin: '0 0 22px', maxWidth: '32em' }}>
          FieldStay is built by two people who spent their careers running operations
          and logistics, not building software.
        </p>
        <p style={{ fontFamily: SERIF, fontSize: 'clamp(17px, 2.3vw, 20px)', lineHeight: 1.65, color: 'var(--mkt-ed-body)', margin: 0, maxWidth: '40em' }}>
          We are Stephen and Bryan, former coworkers turned founders. We spent most of
          our careers in hospitality operations and logistics, including at Auburn
          University. We managed vendors, performed inspections, created detailed
          cleaning lists, were responsible for P&amp;L reports, made schedules, and dealt
          with staffing issues every single day. Software came later. We built it
          because we wanted to take best practices and systems that we knew worked and
          make it available to anyone.
        </p>

        {SECTIONS.map((s) => (
          <SectionBlock key={s.id} section={s} />
        ))}

        <section style={{ borderTop: '1px solid var(--mkt-ed-rule)', paddingTop: 'clamp(30px, 5vw, 48px)' }}>
          <p style={{ fontFamily: SERIF, fontSize: 'clamp(17px, 2.3vw, 20px)', lineHeight: 1.65, color: 'var(--mkt-ed-body)', margin: '0 0 24px', maxWidth: '40em' }}>
            If you would rather ask us something before you try it, that is the easier
            way round and we would rather you did.
          </p>
          <div className="flex flex-col sm:flex-row sm:items-center" style={{ gap: 14 }}>
            <Link
              href="/signup"
              className="rounded-full text-center font-bold w-full sm:w-auto transition-colors hover:bg-[var(--mkt-gold-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mkt-ed-bg)] focus-visible:ring-[var(--mkt-gold)]"
              style={{ background: 'var(--mkt-gold)', color: 'var(--mkt-ed-ink)', border: '1px solid var(--mkt-ed-ink)', padding: '16px 28px', fontSize: 16 }}
            >
              Start 14-day Trial
            </Link>
            <a
              href="mailto:hello@fieldstay.app?subject=A%20question%20about%20FieldStay"
              className="inline-block rounded-full text-center font-semibold w-full sm:w-auto transition-colors hover:border-[var(--mkt-ed-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mkt-ed-bg)] focus-visible:ring-[var(--mkt-gold)]"
              style={{ color: 'var(--mkt-ed-ink)', border: '1px solid var(--mkt-ed-rule)', padding: '16px 26px', fontSize: 16 }}
            >
              Email us
            </a>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
