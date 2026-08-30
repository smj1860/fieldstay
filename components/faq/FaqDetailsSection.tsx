// ============================================================================
// The shared <details>/<summary> FAQ accordion used by comparison/capability
// landing pages (currently /strops and /breezeway-alternative).
//
// Not the same component as FaqSection.tsx in this directory — that one is a
// client component with useState-driven open/close state and a ChevronDown
// icon, built for OwnerRez/Hospitable's connector pages. This one needs no
// JS at all: <details> is natively interactive, which is why these pages use
// it — a crawler or a JS-disabled browser still gets working, readable FAQ
// content. Extracted after app/strops/page.tsx and
// app/breezeway-alternative/page.tsx were found carrying a byte-identical
// copy of this section (SonarCloud duplication check, 2026-08-30) — same
// shape as the FaqSection.tsx extraction below it.
//
// Content lives in lib/faq-content.ts; only the { question, answer } shape
// is required here so a caller isn't forced to import the full FaqItem type
// (which also carries an `id` this component never uses).
// ============================================================================

export interface FaqDetailsItem {
  question: string
  answer:   string
}

interface FaqDetailsSectionProps {
  /** Q&A pairs, in display order. Sourced from lib/faq-content.ts. */
  items: readonly FaqDetailsItem[]
  /** Defaults to the copy every current caller uses. */
  heading?: string
}

export default function FaqDetailsSection({
  items,
  heading = 'Questions people actually ask',
}: Readonly<FaqDetailsSectionProps>) {
  return (
    <section className="bg-[var(--mkt-surface)] border-t border-[var(--mkt-border)]">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-[var(--mkt-ink)] mb-10 font-display text-center">
          {heading}
        </h2>
        <div className="space-y-4">
          {items.map((f) => (
            <details
              key={f.question}
              className="group rounded-xl border border-[var(--mkt-border)] bg-white p-5"
            >
              <summary className="font-semibold text-[var(--mkt-ink)] cursor-pointer list-none flex justify-between items-center gap-4">
                {f.question}
                <span
                  aria-hidden="true"
                  className="text-[var(--mkt-gold)] text-xl leading-none group-open:rotate-45 transition-transform"
                >
                  +
                </span>
              </summary>
              <p className="text-sm text-[var(--mkt-muted-strong)] leading-relaxed mt-3">
                {f.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}
