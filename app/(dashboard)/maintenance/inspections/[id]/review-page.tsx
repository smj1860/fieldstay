'use client'

// The last page, and the only gate.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS AT ALL
//
// Next is deliberately never blocked. A walk is not linear — an inspector skips
// the locked utility room and comes back — so trapping them on a page fights
// the job rather than the mistake. The cost of that decision is that the linear
// path can reach the signature with a section quietly unanswered, and this page
// is what pays it: the pager ends in a list of exactly what the walk missed,
// each entry one tap from the page it is on.
//
// Sign-off is the ONE place that blocks, because the artifact it produces is a
// certification. A signed declaration that "all verified items meet standard
// operational safety guidelines" over a form with eleven blank items is not an
// incomplete record — it is a false one.

import { AlertTriangle, CheckCircle2 } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import type { OutstandingItem } from '@/lib/inspections/resolve-form'

const REASON_LABEL: Record<OutstandingItem['reason'], string> = {
  unanswered:             'Not answered',
  fail_needs_description: 'Needs a description',
  needs_photo:            'Needs a photo, or a reason there isn’t one',
}

interface Props {
  outstanding:   OutstandingItem[]
  inspectorName: string
  onInspectorNameChange: (name: string) => void
  onGoToPage:    (pageIndex: number) => void
  onSignOff:     () => void
  submitting:    boolean
  error:         string | null
}

export function ReviewPage({
  outstanding, inspectorName, onInspectorNameChange, onGoToPage, onSignOff, submitting, error,
}: Readonly<Props>) {
  const clear = outstanding.length === 0

  return (
    <div className="flex flex-col gap-4">
      {clear ? (
        <Card>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5" style={{ color: 'var(--accent-green)' }} />
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Every question has an answer.
            </p>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-5 h-5" style={{ color: 'var(--accent-amber)' }} />
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {outstanding.length} {outstanding.length === 1 ? 'item needs' : 'items need'} an answer
            </p>
          </div>
          <ul className="flex flex-col">
            {outstanding.map((o) => (
              <li key={`${o.itemKey}-${o.repeatIndex ?? ''}-${o.assetId ?? ''}`}
                  style={{ borderTop: '1px solid var(--border)' }}>
                <button
                  type="button"
                  onClick={() => onGoToPage(o.pageIndex)}
                  className="w-full text-left py-2.5 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent-gold)]"
                >
                  <span className="block text-sm" style={{ color: 'var(--text-primary)' }}>
                    {o.prompt}
                    {o.repeatIndex !== undefined && (
                      <span style={{ color: 'var(--text-muted)' }}> · #{o.repeatIndex}</span>
                    )}
                  </span>
                  <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {o.sectionName} · {REASON_LABEL[o.reason]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <h2 className="text-sm font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
          Inspector sign-off &amp; verification
        </h2>
        {/* Verbatim from §12.1. This is the declaration the signature attests
            to, so it is shown in full above the name field rather than
            summarised — a certification nobody read is not a certification. */}
        <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
          I hereby certify that the property listed above has undergone a comprehensive
          safety inspection on the date indicated, and all verified items meet standard
          operational safety guidelines.
        </p>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="inspector-name" className="text-xs font-semibold"
                 style={{ color: 'var(--text-secondary)' }}>
            Inspector name
          </label>
          {/* Free text, and §5 is explicit about why: whoever the PM handed the
              tablet to counts as the inspector, account or not. It is a
              different fact from completed_by_user_id, and the two may
              legitimately disagree. */}
          <Input
            id="inspector-name"
            value={inspectorName}
            onChange={(e) => onInspectorNameChange(e.target.value)}
            placeholder="Full name of whoever walked the property"
            autoComplete="off"
          />
        </div>

        {error && (
          <p className="text-xs mt-3" role="alert" style={{ color: 'var(--accent-red)' }}>
            {error}
          </p>
        )}

        <Button
          variant="cta"
          className="w-full mt-4"
          disabled={!clear || !inspectorName.trim() || submitting}
          onClick={onSignOff}
        >
          {submitting ? 'Signing off…' : 'Sign off and complete'}
        </Button>

        {!clear && (
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Sign-off is available once every question above has an answer.
          </p>
        )}
      </Card>
    </div>
  )
}
