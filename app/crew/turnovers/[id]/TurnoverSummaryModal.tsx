'use client'
import { useState } from 'react'
import { CheckCircle2, Loader2, StickyNote } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { submitTurnoverSummaryNotes } from '@/lib/dexie/helpers'

export function TurnoverSummaryModal({
  turnoverId,
  initialNotes,
  userId,
  onClose,
}: Readonly<{
  turnoverId:   string
  initialNotes: string
  userId:       string
  onClose:      () => void
}>) {
  const [notes,      setNotes]      = useState(initialNotes)
  const [submitting, setSubmitting] = useState(false)
  const [success,    setSuccess]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!notes.trim()) { setError('Please add a note for the property manager.'); return }
    setSubmitting(true)
    setError(null)

    try {
      await submitTurnoverSummaryNotes(userId, turnoverId, notes.trim())
      setSuccess(true)
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={success ? 'Notes Saved' : 'Turnover Summary & Additional Notes'}
      maxWidthClassName="max-w-sm"
      mobileSheet
      footer={
        success ? (
          <Button onClick={onClose} className="w-full">Done</Button>
        ) : (
          <button
            type="submit"
            form="turnover-summary-form"
            disabled={submitting}
            className="w-full py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            style={{ background: 'var(--accent-amber)', color: 'var(--text-inverse)' }}
          >
            {submitting
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
              : <><StickyNote className="w-4 h-4" /> Save Notes</>
            }
          </button>
        )
      }
    >
      {success ? (
        <div className="text-center py-4">
          <CheckCircle2 className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--accent-green)' }} />
          <p className="text-sm text-muted-themed">
            Saved. The property manager will see this on the turnover as soon as
            your phone has a connection.
          </p>
        </div>
      ) : (
        <>
          {error && (
            <div
              className="text-sm rounded-lg px-3 py-2 mb-3"
              style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)' }}
            >
              {error}
            </div>
          )}

          <form id="turnover-summary-form" onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label htmlFor="turnover-summary-notes" className="label text-primary-themed">Anything the PM should know? *</label>
              <textarea
                id="turnover-summary-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                className="input resize-none"
                placeholder="A summary of the turnover, anything unusual, or additional notes for the property manager…"
                required
              />
            </div>
          </form>
        </>
      )}
    </Dialog>
  )
}
