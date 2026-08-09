// ============================================================================
// The shared landing-page FAQ accordion.
//
// components/ownerrez/faq-section.tsx and components/hospitable/faq-section
// .tsx were 106 lines each whose render code was BYTE-IDENTICAL — the entire
// diff outside the Q&A data was one comment, and that comment already pointed
// at lib/faq-content.ts, where the shared answers had been extracted without
// the markup following them.
//
// Same extraction as components/pricing/: the markup below is the OwnerRez
// file's, unchanged apart from taking its items as a prop, so neither live
// page shifts by a pixel. Colors move to the --mkt-* palette on the way
// through, which is a no-op (identical hexes) and takes both files off the
// tailwind-color-ratchet baseline.
//
// Q&A content lives in lib/faq-content.ts.
// ============================================================================

'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

export interface FaqSectionItem {
  q: string
  a: string
}

interface FaqSectionProps {
  /** Q&A pairs, in display order. Sourced from lib/faq-content.ts. */
  items: readonly FaqSectionItem[]
}

export default function FaqSection({ items }: Readonly<FaqSectionProps>) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)

  return (
    <div className="bg-white border-t border-[var(--mkt-border)]">
      <div className="max-w-3xl mx-auto px-6 py-20">

        <h2 className="text-3xl font-bold text-center text-[var(--mkt-ink)] mb-2 font-display">
          Common questions
        </h2>
        <p className="text-center text-[var(--mkt-muted)] mb-12">
          Quick answers before you connect.
        </p>

        <div className="divide-y divide-[var(--mkt-border)] border border-[var(--mkt-border)] rounded-2xl overflow-hidden">
          {items.map((faq, idx) => {
            const isOpen = openIdx === idx
            return (
              <div key={idx}>
                <button
                  onClick={() => setOpenIdx(isOpen ? null : idx)}
                  aria-expanded={isOpen}
                  className="w-full flex items-start justify-between gap-4
                             px-6 py-5 text-left transition-colors"
                  style={{ background: isOpen ? 'var(--mkt-surface)' : 'white' }}
                >
                  <span className="text-sm font-semibold text-[var(--mkt-ink)] leading-snug pt-px">
                    {faq.q}
                  </span>
                  <ChevronDown
                    className="w-4 h-4 flex-shrink-0 mt-0.5 transition-transform duration-200 text-[var(--mkt-muted)]"
                    style={{
                      transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    }}
                  />
                </button>
                {isOpen && (
                  <p className="px-6 pb-5 text-sm text-[var(--mkt-muted)] leading-relaxed">
                    {faq.a}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <p className="text-center text-sm text-[var(--mkt-muted)] mt-8">
          Something else?{' '}
          <a
            href="mailto:support@fieldstay.app"
            className="text-[var(--mkt-ink)] underline font-medium hover:opacity-70
                       transition-opacity"
          >
            Email us
          </a>{' '}
          — we respond same day.
        </p>

      </div>
    </div>
  )
}
