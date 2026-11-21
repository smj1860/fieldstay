'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import type { ReadyCall } from '@/lib/gtm/dashboard'
import { decideAgentTask, markCallMade } from '../agents-actions'

type CopyTarget = 'phone' | 'brief'

function CallRow({ call, ageLabel }: Readonly<{ call: ReadyCall; ageLabel: string }>) {
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

  return (
    <li className="py-4 border-t first:border-t-0" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{call.company ?? 'Unknown account'}</span>
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>call {call.contactName ?? 'the contact'}</span>
        {call.phone && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{call.phone}</span>}
        <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>approved {ageLabel}</span>
      </div>

      <pre
        className="mt-2 text-xs whitespace-pre-wrap rounded p-3 max-h-72 overflow-auto"
        style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
      >
        {call.brief}
      </pre>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {call.phone && (
          <Button type="button" variant="secondary" onClick={() => copy('phone', call.phone ?? '')}>
            {copied === 'phone' ? 'Copied number' : 'Copy number'}
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={() => copy('brief', call.brief)}>
          {copied === 'brief' ? 'Copied brief' : 'Copy brief'}
        </Button>
        <span className="grow" />
        <Button type="button" variant="ghost" disabled={pending} onClick={() => settle(() => decideAgentTask(call.id, 'cancel'))}>
          Discard
        </Button>
        <Button type="button" variant="primary" disabled={pending} onClick={() => settle(() => markCallMade(call.id))}>
          I called
        </Button>
      </div>
      {error && <p role="alert" className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>}
    </li>
  )
}

export function ReadyCalls({ calls, ages }: Readonly<{ calls: ReadyCall[]; ages: Record<string, string> }>) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Call briefs</h3>
        <Badge tone={calls.length > 0 ? 'green' : 'slate'}>{calls.length} approved</Badge>
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
        Read the brief, then call from your own phone. FieldStay places no calls, and no agent ever speaks to a
        prospect. Press &quot;I called&quot; afterwards so the account records it.
      </p>

      {calls.length === 0 ? (
        <p className="text-sm mt-4" style={{ color: 'var(--text-muted)' }}>
          No approved briefs are waiting. Ask for one from an account&apos;s edit window.
        </p>
      ) : (
        <ul className="mt-2">
          {calls.map((c) => <CallRow key={c.id} call={c} ageLabel={ages[c.id] ?? ''} />)}
        </ul>
      )}
    </Card>
  )
}
