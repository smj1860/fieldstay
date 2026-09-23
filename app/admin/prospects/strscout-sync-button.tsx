'use client'

import { useId, useState, useTransition } from 'react'
import { DownloadCloud } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Checkbox } from '@/components/ui/Checkbox'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { planStrscoutSync, applyStrscoutSync } from './strscout-actions'
import type { StrscoutPlanSummary } from './strscout-constants'

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/**
 * Pulls the strscout scraper's ICP list into the funnel.
 *
 * Always a preview first: this adds rows in the hundreds to a list someone is
 * working, and an "add count" close to the whole scraper list means the match
 * key is missing accounts it should be finding — which is the failure worth
 * catching BEFORE it doubles the table, not after.
 *
 * It exists as a button and not only as scripts/prospecting/sync-str-prospects.ts
 * because this funnel gets worked from a phone, and a tool that needs a
 * terminal is a tool that does not get run.
 */
export function StrscoutSyncButton() {
  const [open, setOpen]         = useState(false)
  const [sizedOnly, setSizedOnly] = useState(false)
  const [summary, setSummary]   = useState<StrscoutPlanSummary | null>(null)
  const [done, setDone]         = useState<{ added: number; filled: number } | null>(null)
  const [error, setError]       = useState('')
  const [pending, startTransition] = useTransition()
  const sizedId = useId()

  function loadPlan(nextSizedOnly: boolean): void {
    setError('')
    setSummary(null)
    startTransition(async () => {
      const res = await planStrscoutSync(nextSizedOnly)
      if (res.summary === undefined) {
        setError(res.error ?? 'Could not read the scraper list.')
        return
      }
      setSummary(res.summary)
    })
  }

  function openDialog(): void {
    setOpen(true)
    setDone(null)
    loadPlan(sizedOnly)
  }

  function toggleSized(next: boolean): void {
    setSizedOnly(next)
    loadPlan(next)
  }

  function apply(): void {
    setError('')
    startTransition(async () => {
      const res = await applyStrscoutSync(sizedOnly)
      if (res.added === undefined) {
        setError(res.error ?? 'The sync failed.')
        return
      }
      setDone({ added: res.added, filled: res.filled ?? 0 })
      setSummary(null)
    })
  }

  return (
    <>
      <Button
        variant="secondary"
        onClick={openDialog}
        disabled={pending}
        className="text-xs flex items-center gap-1"
      >
        <DownloadCloud size={14} aria-hidden="true" /> Pull from scraper
      </Button>

      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          title="Pull from the scraper"
          mobileSheet
          footer={
            <>
              {summary !== null && summary.wouldAdd + summary.wouldFill > 0 && (
                <Button variant="primary" onClick={apply} disabled={pending}>
                  {pending ? 'Working…' : `Add ${plural(summary.wouldAdd, 'account', 'accounts')}`}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                Close
              </Button>
            </>
          }
        >
          <div className="space-y-4 pt-2">
            {error !== '' && <InlineAlert tone="error">{error}</InlineAlert>}

            {done !== null && (
              <>
                <InlineAlert tone="success">
                  Added {plural(done.added, 'account', 'accounts')} and filled in{' '}
                  {plural(done.filled, 'existing account', 'existing accounts')}.
                </InlineAlert>
                <Button variant="secondary" onClick={() => globalThis.location.reload()}>
                  Reload to see them
                </Button>
              </>
            )}

            {done === null && (
              <>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={sizedId}
                    checked={sizedOnly}
                    disabled={pending}
                    onChange={(e) => toggleSized(e.target.checked)}
                  />
                  <label
                    htmlFor={sizedId}
                    className="text-sm cursor-pointer"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Only companies with a known door count
                  </label>
                </div>

                {summary === null && error === '' && (
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    Checking the scraper list…
                  </p>
                )}

                {summary !== null && <PlanSummary summary={summary} />}
              </>
            )}
          </div>
        </Dialog>
      )}
    </>
  )
}

function PlanSummary({ summary }: Readonly<{ summary: StrscoutPlanSummary }>) {
  if (summary.considered === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        The scraper has nothing that qualifies right now.
      </p>
    )
  }

  const nothingToDo = summary.wouldAdd + summary.wouldFill === 0

  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
        <strong>{summary.considered.toLocaleString()}</strong> companies qualify.
        Would add <strong>{summary.wouldAdd.toLocaleString()}</strong> and fill
        in blanks on <strong>{summary.wouldFill.toLocaleString()}</strong> you
        already have.
        {summary.untouched > 0 && (
          <> {summary.untouched.toLocaleString()} already match and would not change.</>
        )}
      </p>

      {nothingToDo && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Nothing to do — the funnel is already up to date with the scraper.
        </p>
      )}

      {summary.droppedDomains > 0 && (
        <p className="text-xs" style={{ color: 'var(--accent-amber)' }}>
          {summary.droppedDomains.toLocaleString()} would be added without their
          domain — another account already claims it.
        </p>
      )}

      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Accounts you already have are only ever filled in where a field is
        empty. Nothing here can change a status, a note, a next action or a
        contact you entered.
      </p>

      {summary.fields.length > 0 && (
        <details>
          <summary className="text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            Fields that would be written
          </summary>
          <ul className="mt-1 grid gap-0.5 sm:grid-cols-3">
            {summary.fields.map((f) => (
              <li key={f.column} className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {f.column} — {f.count.toLocaleString()}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
