import Link from 'next/link'
import { SiteHeader } from '@/components/landing/site-header'
import { SiteFooter } from '@/components/landing/site-footer'
import { PUBLIC_FAQ } from '@/lib/faq-content'

// ============================================================================
// /faq — the public FAQ. Every question on it is PUBLIC_FAQ in
// lib/faq-content.ts, which selects them by id out of the same FAQ_CATEGORIES
// the in-app help page renders. See that export's comment for why this is a
// selection rather than a page-local copy; the short version is that a second
// copy of an answer is a second thing to correct, and nobody corrects both.
//
// ── Native <details>, and no client component ─────────────────────────────
//
// <details>/<summary> is natively interactive, so this page ships zero
// JavaScript and stays a Server Component. That matters more here than on an
// ordinary page for two reasons. A crawler reading an FAQ needs the ANSWERS in
// the markup, not behind a useState that only runs after hydration, which is
// also what makes the FAQPage structured data in json-ld.ts honest rather than
// a claim about content a reader cannot reach. And /faq is a page people arrive
// at from a search result on a phone, where hydration is the slowest part.
//
// components/faq/FaqDetailsSection.tsx already does <details> for /strops and
// /breezeway-alternative and is deliberately NOT reused: it renders no site
// chrome and it is painted in the OLDER --mkt-* landing palette (--mkt-surface,
// --mkt-ink, plus a hardcoded bg-white), whereas this page sits in the site
// menu beside /features, /why-fieldstay and /integrations and has to match
// their --mkt-ed-* editorial treatment. Reusing it would mean either a
// palette-swap prop on a component with two settled callers, or a page that
// looks like it came from a different site.
//
// ── The order is the argument ────────────────────────────────────────────
//
// Not alphabetical and not grouped under headings. Flat, in the order a
// stranger's doubts actually arrive: what IS this next to the tools I already
// pay for, then what will it cost, then what happens to my crew, then what
// happens to my systems and my data. PUBLIC_FAQ_IDS carries those four groups
// as comments; they are deliberately NOT rendered as headings, because every
// entry is collapsed to one line and the whole list is visible at once, so
// headings would be scaffolding over something you can already see the end of.
// Revisit that if this ever passes roughly twenty.
// ============================================================================

const HEADER_LINKS = [
  { label: 'Features',     href: '/features' },
  { label: 'Pricing',      href: '/pricing' },
  { label: 'Integrations', href: '/integrations' },
] as const

const SERIF = 'var(--font-source-serif), Georgia, serif'
const SANS  = 'var(--font-archivo), Arial, sans-serif'

function FaqEntry({ question, answer }: Readonly<{ question: string; answer: string }>) {
  return (
    <details
      className="group rounded-[14px]"
      style={{ background: 'var(--mkt-ed-bg-alt)', border: '1px solid var(--mkt-ed-rule)' }}
    >
      <summary
        className="flex items-start justify-between cursor-pointer list-none rounded-[14px] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--mkt-gold)]"
        style={{
          gap: 18, padding: 'clamp(16px, 2.6vw, 22px) clamp(16px, 2.6vw, 24px)',
          fontFamily: SANS, fontSize: 'clamp(16px, 2.1vw, 18px)', fontWeight: 600,
          color: 'var(--mkt-ed-ink)', lineHeight: 1.35,
        }}
      >
        {question}
        {/* Decoration: the open/closed state is already conveyed by <details>
            itself, which a screen reader announces. */}
        <span
          aria-hidden="true"
          className="shrink-0 transition-transform group-open:rotate-45"
          style={{ color: 'var(--mkt-gold)', fontSize: 24, lineHeight: 1, marginTop: -1 }}
        >
          +
        </span>
      </summary>
      <p
        style={{
          fontFamily: SERIF, fontSize: 'clamp(16px, 2.1vw, 18px)', lineHeight: 1.65,
          color: 'var(--mkt-ed-body)', margin: 0,
          padding: '0 clamp(16px, 2.6vw, 24px) clamp(18px, 2.6vw, 24px)',
          maxWidth: '44em',
        }}
      >
        {answer}
      </p>
    </details>
  )
}

export function FaqContent() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--mkt-ed-bg)', color: 'var(--mkt-ed-ink)', fontFamily: SANS }}>
      <SiteHeader links={HEADER_LINKS} />

      <main style={{ maxWidth: 860, margin: '0 auto', padding: 'clamp(44px, 8vw, 88px) clamp(16px, 3.5vw, 40px) clamp(64px, 10vw, 112px)' }}>
        <h1
          className="font-display font-semibold"
          style={{ fontSize: 'clamp(38px, 7vw, 62px)', lineHeight: 1.0, letterSpacing: '-0.03em', margin: '0 0 clamp(18px, 3vw, 26px)', maxWidth: '18ch' }}
        >
          Questions people ask.
        </h1>
        <p style={{ fontFamily: SERIF, fontSize: 'clamp(19px, 3vw, 24px)', lineHeight: 1.5, margin: '0 0 clamp(32px, 5vw, 48px)', maxWidth: '32em' }}>
          These are some of the questions that we get asked the most, answered
          honestly and plainly.
        </p>

        <div className="flex flex-col" style={{ gap: 12 }}>
          {PUBLIC_FAQ.map((f) => (
            <FaqEntry key={f.id} question={f.question} answer={f.answer} />
          ))}
        </div>

        {/* TWO offers, each with its own button, rather than one paragraph and
            a button pair. Owner's copy and owner's structure: an email first,
            because the heading promises an answer and a trial is not one, then
            the trial as the alternative for someone who would rather just look.

            Email is OUTLINED and the trial is FILLED. Both are real actions, so
            both get a button, but two gold fills in one panel would leave the
            eye nowhere to land. The outline is the same treatment the closing
            CTA on /integrations uses, and gold on ink measures 10.66:1 as
            text and as a border.

            The old "See every feature" link is gone with the rewrite; /features
            is still one tap away in the menu and the footer. */}
        <section
          className="rounded-[20px] sm:rounded-[28px]"
          style={{ background: 'var(--mkt-ed-ink)', padding: 'clamp(30px, 6vw, 52px) clamp(18px, 4.5vw, 52px)', marginTop: 'clamp(40px, 6vw, 64px)' }}
        >
          <h2
            className="font-display font-semibold"
            style={{ fontSize: 'clamp(24px, 3.4vw, 34px)', lineHeight: 1.15, letterSpacing: '-0.02em', color: 'var(--mkt-ed-on-ink-strong)', margin: '0 0 12px' }}
          >
            Still have questions?
          </h2>
          <p style={{ fontFamily: SERIF, fontSize: 'clamp(17px, 2.3vw, 19px)', lineHeight: 1.6, color: 'var(--mkt-ed-on-ink)', margin: '0 0 24px', maxWidth: '44em' }}>
            We can&rsquo;t cover every question you might have with an FAQ so send us
            an email with your questions, we are happy to answer them all.
          </p>
          <a
            href="mailto:hello@fieldstay.app?subject=A%20question%20about%20FieldStay"
            className="inline-block rounded-full text-center font-semibold w-full sm:w-auto transition-colors hover:border-[var(--mkt-gold-hover)] hover:text-[var(--mkt-gold-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mkt-ed-ink)] focus-visible:ring-[var(--mkt-gold)]"
            style={{ color: 'var(--mkt-gold)', border: '1px solid var(--mkt-gold)', padding: '16px 26px', fontSize: 16 }}
          >
            Email us
          </a>

          <p style={{ fontFamily: SERIF, fontSize: 'clamp(17px, 2.3vw, 19px)', lineHeight: 1.6, color: 'var(--mkt-ed-on-ink)', margin: 'clamp(30px, 4vw, 40px) 0 24px', maxWidth: '44em' }}>
            Rather find answers by trying it out for yourself? Start a 14 day free
            trial today and experience it first hand.
          </p>
          <Link
            href="/signup"
            className="inline-block rounded-full text-center font-bold w-full sm:w-auto transition-colors hover:bg-[var(--mkt-gold-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mkt-ed-ink)] focus-visible:ring-[var(--mkt-gold)]"
            style={{ background: 'var(--mkt-gold)', color: 'var(--mkt-ed-ink)', padding: '17px 28px', fontSize: 16 }}
          >
            Start 14-day Trial
          </Link>
        </section>

      </main>

      <SiteFooter />
    </div>
  )
}
