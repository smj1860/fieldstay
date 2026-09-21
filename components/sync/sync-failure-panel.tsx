'use client'

// The shared presentation for both dead-letter surfaces — the crew PWA's
// FailedSyncBanner and the dashboard's DashboardSyncBanner.
//
// WHY IT WAS EXTRACTED
//
// The dashboard banner was modelled on the crew one and came out 44% duplicated
// against it. That is a very different case from the inspection FORM data,
// where the repetition is a table looking like a table and the right answer was
// a cpd exclusion. Here the two copies encode BEHAVIOURAL rules that were each
// bought with a production bug, and the whole hazard is that they drift:
//
//   - A stalled queue is NOT a failure. It gets an amber notice and NO discard
//     affordance, because the work is intact and still retrying — offering a
//     bin there invites a PM to throw away work that was going to arrive.
//   - A transport failure never sets `failed`, so the stalled notice is that
//     state's only visible surface. The crew version of this was written after
//     photos were found covered by neither surface: a whole shift could retry
//     against a captive portal with nothing on screen.
//   - A dead letter is discarded only behind a confirmation that says plainly
//     that the work never arrived and is about to be gone for good.
//
// Fix one of those in one copy and the other surface silently keeps the bug.
// §8 of docs/INSPECTIONS_SPEC.md makes the same argument about the outbox
// itself: "a second outbox means paying for them twice."
//
// WHAT DELIBERATELY DID NOT MOVE: the Dexie queries, the labels and the
// retry/discard wiring all stay in each surface's own banner. That is the seam
// the two dead-letter guardrails check — they assert on each banner's own
// source for an index-backed `failed` query and a STALLED_NETWORK_ATTEMPTS
// query per outbox. Moving those here would have made both guardrails pass by
// finding the text in a file neither surface has to use.

import { useState } from 'react'
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'

export interface SyncFailureEntry {
  key:     string
  label:   string
  /** Short, user-safe reason. NEVER the payload — it carries notes and costs. */
  detail:  string
  discard: () => Promise<void>
}

interface Props {
  entries:      SyncFailureEntry[]
  stalledCount: number
  onRetryAll:   () => Promise<void>
  /**
   * Second line of the amber notice. Differs by surface only in where the work
   * is held and when the reader should act — "before you finish for the day"
   * for a cleaner, "before you leave the property" for a PM.
   */
  stalledHint:  string
  /** Second line of the red panel. Same reasoning. */
  failedHint:   string
  /**
   * The panel's own chrome — count headlines, buttons, the discard dialog.
   * All optional with English defaults so the dashboard's existing call site
   * (no locale concept) is unaffected; the crew banner passes translated
   * copies. Kept as small formatting functions rather than flat strings
   * because English/Spanish pluralization both depend on the count.
   */
  stalledHeadline?:    (count: number) => string
  failedHeadline?:     (count: number) => string
  discardAriaLabel?:   (label: string) => string
  retryAllLabel?:      string
  retryingLabel?:      string
  discardTitle?:       string
  discardBody?:        (label: string) => string
  keepLabel?:          string
  discardLabel?:       string
}

const defaultStalledHeadline = (count: number) => `${count} change${count !== 1 ? 's' : ''} still trying to sync`
const defaultFailedHeadline  = (count: number) => `${count} item${count !== 1 ? 's' : ''} didn’t sync`
const defaultDiscardAriaLabel = (label: string) => `Discard ${label}`
const defaultDiscardBody = (label: string) => `“${label}” never reached FieldStay. Discarding removes it from this device for good.`

export function SyncFailurePanel({
  entries,
  stalledCount,
  onRetryAll,
  stalledHint,
  failedHint,
  stalledHeadline  = defaultStalledHeadline,
  failedHeadline   = defaultFailedHeadline,
  discardAriaLabel = defaultDiscardAriaLabel,
  retryAllLabel    = 'Retry all',
  retryingLabel    = 'Retrying…',
  discardTitle     = 'Discard this item?',
  discardBody      = defaultDiscardBody,
  keepLabel        = 'Keep it',
  discardLabel     = 'Discard',
}: Readonly<Props>) {
  const [retrying, setRetrying] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState<SyncFailureEntry | null>(null)

  if (entries.length === 0 && stalledCount === 0) return null

  const stalledNotice = stalledCount > 0 && (
    <output
      className="block mx-4 mt-3 rounded-xl p-4"
      style={{ background: 'var(--accent-amber-dim)', border: '1px solid var(--accent-amber-dim)' }}
    >
      <span className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: 'var(--accent-amber)' }} />
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-bold" style={{ color: 'var(--accent-amber)' }}>
            {stalledHeadline(stalledCount)}
          </span>
          <span className="block text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {stalledHint}
          </span>
        </span>
      </span>
    </output>
  )

  // No discard affordance on the stalled path, deliberately — see the header.
  if (entries.length === 0) return <>{stalledNotice}</>

  const retryAll = async () => {
    setRetrying(true)
    try {
      await onRetryAll()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <>
      {stalledNotice}
      <div
        className="mx-4 mt-3 rounded-xl p-4"
        style={{ background: 'var(--accent-red-dim)', border: '1px solid var(--accent-red-dim)' }}
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: 'var(--accent-red)' }} />
          <div className="flex-1 min-w-0">
            {/* The live region is the MESSAGE, not the panel: the list and the
                buttons below sit outside it deliberately. */}
            <output className="block">
              <span className="block text-sm font-bold" style={{ color: 'var(--accent-red)' }}>
                {failedHeadline(entries.length)}
              </span>
              <span className="block text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                {failedHint}
              </span>
            </output>

            <ul className="mt-3 flex flex-col gap-2">
              {entries.map((entry) => (
                <li key={entry.key} className="flex items-center gap-2">
                  <Badge tone="red">{entry.label}</Badge>
                  {entry.detail && (
                    <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                      {entry.detail}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setConfirmDiscard(entry)}
                    aria-label={discardAriaLabel(entry.label)}
                    className="ml-auto p-1.5 -m-1 rounded-lg shrink-0 focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>

            <Button
              variant="danger"
              onClick={() => void retryAll()}
              disabled={retrying}
              className="mt-3 w-full flex items-center justify-center gap-2 py-2.5"
            >
              <RefreshCw className="w-4 h-4" />
              {retrying ? retryingLabel : retryAllLabel}
            </Button>
          </div>
        </div>
      </div>

      {confirmDiscard && (
        <Dialog
          open
          onClose={() => setConfirmDiscard(null)}
          title={discardTitle}
          mobileSheet
          maxWidthClassName="max-w-sm"
          footer={
            <div className="flex flex-col gap-2 w-full">
              <Button variant="secondary" onClick={() => setConfirmDiscard(null)} className="w-full py-3">
                {keepLabel}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const entry = confirmDiscard
                  setConfirmDiscard(null)
                  void entry.discard()
                }}
                className="w-full py-3"
              >
                {discardLabel}
              </Button>
            </div>
          }
        >
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {discardBody(confirmDiscard.label)}
          </p>
        </Dialog>
      )}
    </>
  )
}
