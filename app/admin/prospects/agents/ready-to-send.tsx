'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import type { ReadyDraft } from '@/lib/gtm/dashboard'
import { decideAgentTask, markDraftSent } from '../agents-actions'

type CopyTarget = 'email' | 'subject' | 'body'

function DraftRow({ draft, ageLabel }: Readonly<{ draft: ReadyDraft; ageLabel: string }>) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function copy(target: CopyTarget, text: string) {
    setError(null)
    try {
      await globalThis.navigator.clipboard.writeText(text)
      setCopied(target)
    } catch {
      setError('Could not copy. Select the text and copy it by hand.')
    }
  }

  function settle(action: () => Promise<{ error?: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (result.error) setError(result.error)
      else router.refresh()
    })
  }

  const recipient = draft.contactName ?? 'the contact'

  return (
    <li className="py-4 border-t first:border-t-0" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{draft.company ?? 'Unknown account'}</span>
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>to {recipient}</span>
        {draft.email && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{draft.email}</span>}
        <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>approved {ageLabel}</span>
      </div>

      <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>Subject</p>
      <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{draft.subject}</p>
      <pre
        className="mt-2 text-xs whitespace-pre-wrap rounded p-3 max-h-56 overflow-auto"
        style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
      >
        {draft.body}
      </pre>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {draft.email && (
          <Button type="button" variant="secondary" onClick={() => copy('email', draft.email ?? '')}>
            {copied === 'email' ? 'Copied address' : 'Copy address'}
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={() => copy('subject', draft.subject)}>
          {copied === 'subject' ? 'Copied subject' : 'Copy subject'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => copy('body', draft.body)}>
          {copied === 'body' ? 'Copied body' : 'Copy body'}
        </Button>
        <span className="grow" />
        <Button type="button" variant="ghost" disabled={pending} onClick={() => settle(() => decideAgentTask(draft.id, 'cancel'))}>
          Discard
        </Button>
        <Button type="button" variant="primary" disabled={pending} onClick={() => settle(() => markDraftSent(draft.id))}>
          I sent this
        </Button>
      </div>
      {error && <p role="alert" className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>}
    </li>
  )
}

export function ReadyToSend({ drafts, ages }: Readonly<{ drafts: ReadyDraft[]; ages: Record<string, string> }>) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Ready to send</h3>
        <Badge tone={drafts.length > 0 ? 'green' : 'slate'}>{drafts.length} approved</Badge>
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
        Drafts you approved. FieldStay does not send email: copy one into your own mailbox, send it, then
        press &quot;I sent this&quot; so the account records it.
      </p>

      {drafts.length === 0 ? (
        <p className="text-sm mt-4" style={{ color: 'var(--text-muted)' }}>No approved drafts are waiting.</p>
      ) : (
        <ul className="mt-2">
          {drafts.map((d) => <DraftRow key={d.id} draft={d} ageLabel={ages[d.id] ?? ''} />)}
        </ul>
      )}
    </Card>
  )
}
