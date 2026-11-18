'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { MANAGER_RUN_LABELS } from '@/lib/gtm/constants'
import type { DecisionItem } from '@/lib/gtm/dashboard'
import { requestManagerRun } from '../agents-actions'

function BriefText({ text }: Readonly<{ text: string }>) {
  return (
    <pre
      className="text-xs whitespace-pre-wrap rounded p-3 mt-2"
      style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
    >
      {text}
    </pre>
  )
}

export function ManagerPanel({
  latest, history, ages,
}: Readonly<{ latest: DecisionItem | null; history: DecisionItem[]; ages: Record<string, string> }>) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function runNow() {
    setError(null)
    setMessage(null)
    startTransition(async () => {
      const result = await requestManagerRun()
      if (result.error) setError(result.error)
      else setMessage('Requested. The brief appears here in a few seconds.')
    })
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Manager brief</h3>
          {latest && <Badge tone="slate">{MANAGER_RUN_LABELS[latest.kind]}, {ages[latest.id]}</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={() => router.refresh()}>Refresh</Button>
          <Button type="button" variant="secondary" disabled={pending} onClick={runNow}>Run manager now</Button>
        </div>
      </div>

      {message && <p role="status" className="text-xs mt-2" style={{ color: 'var(--accent-green)' }}>{message}</p>}
      {error && <p role="alert" className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>}

      {latest ? (
        <BriefText text={latest.brief} />
      ) : (
        <p className="text-sm mt-3" style={{ color: 'var(--text-muted)' }}>
          No brief yet. Run the manager to see how it reads the pipeline. It works with the agents switched off,
          using only the numbers, and adds a written summary once it is turned on.
        </p>
      )}

      {history.length > 1 && (
        <details className="mt-3">
          <summary className="text-xs cursor-pointer" style={{ color: 'var(--text-muted)' }}>
            Earlier briefs ({history.length - 1})
          </summary>
          <ul className="mt-2 space-y-3">
            {history.slice(1).map((d) => (
              <li key={d.id}>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {MANAGER_RUN_LABELS[d.kind]}, {ages[d.id]}
                </span>
                <BriefText text={d.brief} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  )
}
