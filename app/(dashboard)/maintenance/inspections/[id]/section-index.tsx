'use client'

// Every page, one tap away.
//
// The counterpart to "Next is navigation only". If the pager is linear and Next
// never blocks, an inspector who skips the locked utility room needs a way back
// to it that is not eight taps of Next — otherwise the unblocked Next quietly
// becomes a one-way door and the Review page's "go to it" links are the only
// route to any page but the current one.
//
// Progress per section counts what is ON SCREEN (pageProgress), never a hidden
// conditional branch: crediting a question the inspector was never shown would
// leave a page permanently short of complete, which reads as "you missed
// something" about nothing.

import { Check } from 'lucide-react'

import { Dialog } from '@/components/ui/Dialog'
import type { ResolvedPage, AnswerState } from '@/lib/inspections/resolve-form'
import { pageProgress } from '@/lib/inspections/resolve-form'

interface Props {
  open:      boolean
  pages:     ResolvedPage[]
  answers:   Readonly<Record<string, AnswerState>>
  current:   number
  onSelect:  (pageIndex: number) => void
  onClose:   () => void
}

export function SectionIndex({ open, pages, answers, current, onSelect, onClose }: Readonly<Props>) {
  if (!open) return null

  return (
    <Dialog open onClose={onClose} title="Sections" mobileSheet maxWidthClassName="max-w-sm">
      <ul className="flex flex-col">
        {pages.map((page, i) => {
          const { answered, total } = pageProgress(page, answers)
          const done = total > 0 && answered === total
          return (
            <li key={page.sectionId} style={{ borderTop: i === 0 ? undefined : '1px solid var(--border)' }}>
              <button
                type="button"
                onClick={() => { onSelect(i); onClose() }}
                aria-current={i === current ? 'step' : undefined}
                className="w-full flex items-center justify-between gap-3 py-3 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent-gold)]"
              >
                <span className="text-sm truncate"
                      style={{
                        color: i === current ? 'var(--accent-gold)' : 'var(--text-primary)',
                        fontWeight: i === current ? 700 : 400,
                      }}>
                  {page.name}
                </span>
                <span className="text-xs shrink-0 flex items-center gap-1.5"
                      style={{ color: done ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                  {done && <Check className="w-3.5 h-3.5" />}
                  {answered}/{total}
                </span>
              </button>
            </li>
          )
        })}

        <li style={{ borderTop: '1px solid var(--border)' }}>
          <button
            type="button"
            onClick={() => { onSelect(pages.length); onClose() }}
            aria-current={current === pages.length ? 'step' : undefined}
            className="w-full py-3 text-left text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent-gold)]"
            style={{
              color: current === pages.length ? 'var(--accent-gold)' : 'var(--text-primary)',
              fontWeight: current === pages.length ? 700 : 400,
            }}
          >
            Review &amp; sign off
          </button>
        </li>
      </ul>
    </Dialog>
  )
}
