'use client'

import { useId, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { TEAM_LABELS } from '@/lib/gtm/constants'
import { previewOutput } from '@/lib/gtm/format'
import type { ApprovalItem } from '@/lib/gtm/dashboard'
import { decideAgentTask } from '../agents-actions'

function ApprovalRow({ item, ageLabel }: Readonly<{ item: ApprovalItem; ageLabel: string }>) {
  const router = useRouter()
  const uid = useId()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  function decide(decision: 'approve' | 'reject') {
    setError(null)
    startTransition(async () => {
      const result = await decideAgentTask(item.id, decision, note)
      if (result.error) setError(result.error)
      else router.refresh()
    })
  }

  return (
    <li className="py-4 border-t first:border-t-0" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="amber">{TEAM_LABELS[item.team]}</Badge>
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {item.taskType.replaceAll('_', ' ')}
        </span>
        {item.company && <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>for {item.company}</span>}
        <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>waiting {ageLabel}</span>
      </div>

      <pre
        className="mt-2 text-xs whitespace-pre-wrap rounded p-3 max-h-56 overflow-auto"
        style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
      >
        {previewOutput(item.output)}
      </pre>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="grow min-w-48">
          <label htmlFor={`${uid}-note`} className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
            Note (optional)
          </label>
          <Input id={`${uid}-note`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button type="button" variant="primary" disabled={pending} onClick={() => decide('approve')}>Approve</Button>
        <Button type="button" variant="danger" disabled={pending} onClick={() => decide('reject')}>Reject</Button>
      </div>
      {error && <p role="alert" className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>}
    </li>
  )
}

export function ApprovalInbox({
  items, totalWaiting, ages,
}: Readonly<{ items: ApprovalItem[]; totalWaiting: number; ages: Record<string, string> }>) {
  const hidden = Math.max(0, totalWaiting - items.length)

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Approval inbox</h3>
        <Badge tone={totalWaiting > 0 ? 'amber' : 'slate'}>{totalWaiting} waiting</Badge>
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
        Drafts and proposals from the teams. Nothing leaves the company until you approve it, longest wait first.
      </p>

      {items.length === 0 ? (
        <p className="text-sm mt-4" style={{ color: 'var(--text-muted)' }}>Nothing is waiting on you.</p>
      ) : (
        <ul className="mt-2">
          {items.map((item) => <ApprovalRow key={item.id} item={item} ageLabel={ages[item.id] ?? ''} />)}
        </ul>
      )}
      {hidden > 0 && (
        <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
          {hidden} more waiting. Handle these and the rest will appear.
        </p>
      )}
    </Card>
  )
}
