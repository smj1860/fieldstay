'use client'

import { useId, useState, useTransition } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { markProspectReplied } from './agents-actions'

function stoppedMessage(stopped: number | undefined): string {
  if (!stopped) return 'Recorded. Follow-up emails for this account are paused.'
  const noun = stopped === 1 ? 'email draft' : 'email drafts'
  return `Recorded. ${stopped} queued ${noun} for this account stopped.`
}

/**
 * Records that this prospect replied. The account leaves the follow-up queue and
 * any email draft still in flight for it is stopped, so nobody sends a templated
 * follow-up to someone who already answered. Nothing is sent. The Server Action
 * revalidates the page, so there is no router refresh here.
 */
export function ReplyButton({ prospectId }: Readonly<{ prospectId: string }>) {
  const uid = useId()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  function record() {
    setMessage(null)
    startTransition(async () => {
      const result = await markProspectReplied(prospectId, note)
      if (result.error) {
        setMessage({ kind: 'error', text: result.error })
        return
      }
      setNote('')
      setMessage({ kind: 'ok', text: stoppedMessage(result.stopped) })
    })
  }

  return (
    <div>
      <label htmlFor={`${uid}-note`} className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
        What they said (optional)
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <div className="grow min-w-48">
          <Input id={`${uid}-note`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button type="button" variant="secondary" disabled={pending} onClick={record}>
          {pending ? 'Recording…' : 'They replied'}
        </Button>
      </div>
      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className="text-xs mt-2"
          style={{ color: message.kind === 'error' ? 'var(--accent-red)' : 'var(--text-secondary)' }}
        >
          {message.text}
        </p>
      )}
    </div>
  )
}
