'use client'

import { useState, useTransition } from 'react'
import { Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { planPmsNormalization, applyPmsNormalization } from './pms-actions'
import { PMS_MAPPINGS_SHOWN, type PmsPlanSummary } from './pms-constants'

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/**
 * Collapses the PMS column to canonical product names.
 *
 * The crawler records its fingerprint inline — "Streamline (ownerx.
 * streamlinevrs.com)" is Streamline — so the facet above lists a separate
 * option per fingerprint and filtering to a product silently misses the
 * companies filed under its variants. This moves the fingerprint into
 * pms_note, where the schema already says that evidence belongs.
 *
 * A button and not only scripts/prospecting/normalize-pms.ts because this
 * funnel gets worked from a phone: the script has existed since the problem
 * was found and has never been run.
 */
export function PmsBackfillButton() {
  const [open, setOpen]       = useState(false)
  const [summary, setSummary] = useState<PmsPlanSummary | null>(null)
  const [done, setDone]       = useState<number | null>(null)
  const [error, setError]     = useState('')
  const [pending, startTransition] = useTransition()

  function openDialog(): void {
    setOpen(true)
    setDone(null)
    setError('')
    setSummary(null)
    startTransition(async () => {
      const res = await planPmsNormalization()
      if (res.summary === undefined) {
        setError(res.error ?? 'Could not read the account list.')
        return
      }
      setSummary(res.summary)
    })
  }

  function apply(): void {
    setError('')
    startTransition(async () => {
      const res = await applyPmsNormalization()
      if (res.changed === undefined) {
        setError(res.error ?? 'The backfill failed.')
        return
      }
      setDone(res.changed)
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
        <Wand2 size={14} aria-hidden="true" /> Tidy PMS names
      </Button>

      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          title="Tidy PMS names"
          mobileSheet
          maxWidthClassName="max-w-2xl"
          footer={
            <>
              {summary !== null && summary.wouldChange > 0 && (
                <Button variant="primary" onClick={apply} disabled={pending}>
                  {pending ? 'Working…' : `Tidy ${plural(summary.wouldChange, 'account', 'accounts')}`}
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
                  Tidied {plural(done, 'account', 'accounts')}. The PMS filter above now
                  lists one option per product.
                </InlineAlert>
                <Button variant="secondary" onClick={() => globalThis.location.reload()}>
                  Reload to see it
                </Button>
              </>
            )}

            {done === null && summary === null && error === '' && (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Checking the accounts…
              </p>
            )}

            {done === null && summary !== null && <PlanSummary summary={summary} />}
          </div>
        </Dialog>
      )}
    </>
  )
}

function PlanSummary({ summary }: Readonly<{ summary: PmsPlanSummary }>) {
  if (summary.wouldChange === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Nothing to tidy — every PMS value is already a plain product name.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
        <strong>{summary.wouldChange.toLocaleString()}</strong> of{' '}
        {summary.considered.toLocaleString()} accounts would change, collapsing{' '}
        <strong>{summary.brandsBefore.toLocaleString()}</strong> PMS values down to{' '}
        <strong>{summary.brandsAfter.toLocaleString()}</strong> products.
      </p>

      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Nothing is thrown away: the fingerprint each name carries moves into
        &ldquo;How the PMS was identified&rdquo;, and a note you wrote yourself is kept and
        added to rather than replaced.
        {summary.wouldClear > 0 && (
          <> {summary.wouldClear.toLocaleString()} value(s) are a remark rather than a
          product and move there whole, leaving the PMS blank.</>
        )}
      </p>

      <details open>
        <summary className="text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
          What changes
        </summary>
        <ul className="mt-1 space-y-0.5">
          {summary.mappings.map((m) => (
            <li
              key={`${m.from}->${m.to ?? ''}`}
              className="text-xs"
              style={{ color: 'var(--text-muted)' }}
            >
              <span style={{ color: 'var(--text-secondary)' }}>{m.from}</span>
              {' → '}
              <span style={{ color: 'var(--text-primary)' }}>{m.to ?? '(blank)'}</span>
              {' · '}{m.count}
            </li>
          ))}
          {summary.wouldChange > PMS_MAPPINGS_SHOWN && (
            <li className="text-xs" style={{ color: 'var(--text-muted)' }}>
              … and more
            </li>
          )}
        </ul>
      </details>

      <details>
        <summary className="text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
          Products afterwards ({summary.brands.length})
        </summary>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          {summary.brands.join(', ')}
        </p>
      </details>
    </div>
  )
}
