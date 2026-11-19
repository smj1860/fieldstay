'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/Button'
import { requestCallBrief } from './agents-actions'

/**
 * Asks Sales Ops for a call brief on this account. The brief lands in the Agents
 * approval inbox; nothing is dialed and nothing is sent.
 */
export function CallBriefButton({ prospectId }: Readonly<{ prospectId: string }>) {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  function request() {
    setMessage(null)
    startTransition(async () => {
      const result = await requestCallBrief(prospectId)
      setMessage(result.error
        ? { kind: 'error', text: result.error }
        : { kind: 'ok', text: 'Requested. The brief will appear in the Agents approval inbox.' })
    })
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" disabled={pending} onClick={request}>
          {pending ? 'Requesting…' : 'Prepare call brief'}
        </Button>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Questions to ask and what we do not know. You place the call yourself.
        </span>
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
