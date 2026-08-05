'use client'

import { useState, useTransition } from 'react'
import { Loader2, ShieldAlert } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { RequiredMark } from '@/components/ui/RequiredMark'
import { reportError } from '@/lib/observability/report-error'
import { anonymizeGuestData } from './actions'

type Outcome =
  | { kind: 'idle' }
  | { kind: 'error';   message: string }
  | { kind: 'done';    bookings: number; optInsDeleted: number; optInsRetained: number }

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * The operator has to be able to answer the data subject from this one line,
 * including the part that says something was deliberately NOT deleted.
 */
function successMessage(o: Extract<Outcome, { kind: 'done' }>): string {
  if (o.bookings === 0) {
    return 'No bookings matched that email address. Nothing was changed.'
  }
  const parts = [`Erased across ${plural(o.bookings, 'booking')}.`]
  if (o.optInsDeleted > 0) {
    parts.push(`${plural(o.optInsDeleted, 'SMS opt-in record')} deleted.`)
  }
  if (o.optInsRetained > 0) {
    parts.push(
      `${plural(o.optInsRetained, 'opt-out record')} retained — a STOP is a TCPA ` +
      'suppression record and must be kept so the number is never texted again.'
    )
  }
  return parts.join(' ')
}

/**
 * The erasure is IRREVERSIBLE and org-wide, so it is behind a typed
 * confirmation rather than a single click. The dialog echoes the exact address
 * back — an operator acting on a ticket is one paste away from scrubbing the
 * wrong guest, and there is no undo.
 */
export function ErasureForm() {
  const [email,    setEmail]    = useState('')
  const [confirm,  setConfirm]  = useState(false)
  const [outcome,  setOutcome]  = useState<Outcome>({ kind: 'idle' })
  const [pending,  startErasure] = useTransition()

  const trimmed = email.trim()
  const valid   = trimmed.includes('@') && trimmed.length > 2

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    setOutcome({ kind: 'idle' })
    setConfirm(true)
  }

  function runErasure() {
    startErasure(async () => {
      try {
        const result = await anonymizeGuestData(trimmed)
        setConfirm(false)
        if (!result.success) {
          setOutcome({ kind: 'error', message: result.error ?? 'Erasure failed. Please try again.' })
          return
        }
        setOutcome({
          kind:          'done',
          bookings:      result.bookingsAnonymized,
          optInsDeleted: result.optInsDeleted ?? 0,
          // Deliberately surfaced rather than hidden: a retained STOP record is
          // a legal obligation that survives the erasure, and the operator
          // answering the data subject needs to be able to say so.
          optInsRetained: result.optInsRetained ?? 0,
        })
        setEmail('')
      } catch (err) {
        reportError(err, { site: 'component.settings.privacy.ErasureForm' })
        setConfirm(false)
        setOutcome({ kind: 'error', message: 'Erasure failed. Please try again.' })
      }
    })
  }

  return (
    <Card>
      <div className="flex items-start gap-3 mb-4">
        <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--accent-red)' }} />
        <div>
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            Erase a guest&apos;s data
          </h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            GDPR Article 17 / CCPA right to deletion. Clears the guest&apos;s name, email,
            the raw booking feed payload, their stored door code, and their SMS opt-in
            across every booking in this organization. The booking records themselves are
            kept so owner statements and occupancy history stay intact.
          </p>
        </div>
      </div>

      {outcome.kind === 'error' && (
        <InlineAlert tone="error" className="mb-4">{outcome.message}</InlineAlert>
      )}

      {outcome.kind === 'done' && (
        <InlineAlert tone="success" className="mb-4">{successMessage(outcome)}</InlineAlert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="erasure-email" className="label">
            Guest email address <RequiredMark />
          </label>
          <Input
            id="erasure-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="guest@example.com"
            autoComplete="off"
          />
          <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>
            Matched exactly against the guest email on each booking, case-insensitively.
          </p>
        </div>

        <Button type="submit" variant="danger" disabled={!valid || pending}>
          Erase guest data
        </Button>
      </form>

      <Dialog
        open={confirm}
        onClose={() => { if (!pending) setConfirm(false) }}
        title="Erase this guest's data?"
        mobileSheet
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setConfirm(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={runErasure} disabled={pending} className="flex items-center gap-1.5">
              {pending && <Loader2 className="w-4 h-4 animate-spin" />}
              {pending ? 'Erasing…' : 'Erase permanently'}
            </Button>
          </div>
        }
      >
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          This permanently erases all personal data held for{' '}
          <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{trimmed}</span>{' '}
          across every booking in this organization. It cannot be undone, and the
          data cannot be recovered from a backup for you.
        </p>
      </Dialog>
    </Card>
  )
}
