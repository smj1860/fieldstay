'use client'

import { useId, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { MAX_INSTRUCTION_CHARS } from '@/lib/gtm/manager/instructions'
import type { InstructionItem, PlaybookItem } from '@/lib/gtm/dashboard'
import {
  decideManagerInstruction,
  setStandingPermission,
  submitManagerInstruction,
} from '../manager-instruction-actions'

type Tone = 'green' | 'amber' | 'red' | 'blue' | 'slate'

const STATUS_LABELS: Record<string, { label: string; tone: Tone }> = {
  interpreting: { label: 'Reading', tone: 'blue' },
  proposed:     { label: 'Needs your approval', tone: 'amber' },
  unclear:      { label: 'Not understood', tone: 'slate' },
  rejected:     { label: 'Rejected', tone: 'slate' },
  applying:     { label: 'Working', tone: 'blue' },
  applied:      { label: 'Done', tone: 'green' },
  failed:       { label: 'Needs a look', tone: 'red' },
}

function ReplyBox({ briefId }: Readonly<{ briefId: string | null }>) {
  const router = useRouter()
  const uid = useId()
  const [text, setText] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function send() {
    setError(null)
    startTransition(async () => {
      const result = await submitManagerInstruction(text, briefId)
      if (result.error) {
        setError(result.error)
        return
      }
      setText('')
      router.refresh()
    })
  }

  return (
    <div>
      <label htmlFor={`${uid}-reply`} className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
        Reply to the manager
      </label>
      <textarea
        id={`${uid}-reply`}
        className="input w-full"
        rows={3}
        value={text}
        maxLength={MAX_INSTRUCTION_CHARS}
        placeholder="For example: retry the failed drafts, or write the funnel report now."
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-2 flex items-center gap-3">
        <Button type="button" variant="primary" disabled={pending || text.trim().length === 0} onClick={send}>
          Send to the manager
        </Button>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          The manager reads it and proposes what to do. Nothing happens until you approve.
        </span>
      </div>
      {error && <p role="alert" className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>}
    </div>
  )
}

function InstructionRow({ item, age }: Readonly<{ item: InstructionItem; age: string }>) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const status = STATUS_LABELS[item.status] ?? { label: item.status, tone: 'slate' as const }

  function decide(decision: 'approve' | 'reject') {
    setError(null)
    startTransition(async () => {
      const result = await decideManagerInstruction(item.id, decision)
      if (result.error) setError(result.error)
      else router.refresh()
    })
  }

  return (
    <li className="py-3 border-t first:border-t-0" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={status.tone}>{status.label}</Badge>
        {item.source === 'standing' && <Badge tone="gold">On its own</Badge>}
        <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>{age}</span>
      </div>
      <p className="text-sm mt-1" style={{ color: 'var(--text-primary)' }}>{item.instruction}</p>
      {item.reply && <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{item.reply}</p>}
      {item.proposal.length > 0 && item.status === 'proposed' && (
        <ul className="mt-2 list-disc pl-5 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {item.proposal.map((a) => <li key={`${a.kind}-${a.params.team ?? ''}`}>{a.summary}</li>)}
        </ul>
      )}
      {item.outcomes.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {item.outcomes.map((o) => <li key={o}>{o}</li>)}
        </ul>
      )}
      {item.status === 'proposed' && (
        <div className="mt-2 flex gap-2">
          <Button type="button" variant="primary" disabled={pending} onClick={() => decide('approve')}>Approve</Button>
          <Button type="button" variant="danger" disabled={pending} onClick={() => decide('reject')}>Reject</Button>
        </div>
      )}
      {error && <p role="alert" className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>}
    </li>
  )
}

function learnedText(item: PlaybookItem): string {
  const times = item.approved === 1 ? 'time' : 'times'
  const rejected = item.rejected > 0 ? ` and rejected it ${item.rejected}` : ''
  const days = item.cadenceDays === 1 ? 'day' : 'days'
  const rhythm = item.standing
    ? ` It repeats about every ${item.cadenceDays} ${days}, and holds back while 10 or more items are waiting for you.`
    : ''
  return `You have approved this ${item.approved} ${times}${rejected}.${rhythm}`
}

function PlaybookRow({ item }: Readonly<{ item: PlaybookItem }>) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function change(enabled: boolean) {
    setError(null)
    startTransition(async () => {
      const result = await setStandingPermission(item.kind, enabled)
      if (result.error) setError(result.error)
      else router.refresh()
    })
  }

  return (
    <li className="py-3 border-t first:border-t-0" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{item.label}</span>
        {item.standing && <Badge tone="gold">Manager does this on its own</Badge>}
        {item.offered && <Badge tone="amber">Manager is offering to take this over</Badge>}
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{item.description}</p>
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{learnedText(item)}</p>
      <div className="mt-2 flex gap-2">
        {item.offered && (
          <Button type="button" variant="primary" disabled={pending} onClick={() => change(true)}>
            Let the manager do this on its own
          </Button>
        )}
        {item.standing && (
          <Button type="button" variant="secondary" disabled={pending} onClick={() => change(false)}>
            Take this back
          </Button>
        )}
      </div>
      {error && <p role="alert" className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>}
    </li>
  )
}

export function ManagerInstructions({
  briefId, instructions, playbook, ages,
}: Readonly<{
  briefId: string | null
  instructions: InstructionItem[]
  playbook: PlaybookItem[]
  ages: Record<string, string>
}>) {
  const waiting = instructions.filter((i) => i.status === 'proposed').length

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Instructions for the manager</h3>
        <Badge tone={waiting > 0 ? 'amber' : 'slate'}>{waiting} to approve</Badge>
      </div>
      <p className="text-xs mt-1 mb-3" style={{ color: 'var(--text-muted)' }}>
        Reply to a brief and the manager works out what you want and proposes it. Every action only queues work for a team,
        and the team still asks you before anything moves. After you have approved the same kind of instruction a few times,
        the manager offers to take it over. Nothing is automatic until you say yes.
      </p>

      <ReplyBox briefId={briefId} />

      {instructions.length > 0 && (
        <ul className="mt-4">
          {instructions.map((i) => <InstructionRow key={i.id} item={i} age={ages[i.id] ?? ''} />)}
        </ul>
      )}

      <h4 className="text-xs font-semibold mt-5" style={{ color: 'var(--text-primary)' }}>What the manager can do, and what it has learned</h4>
      <ul>{playbook.map((p) => <PlaybookRow key={p.kind} item={p} />)}</ul>
    </Card>
  )
}
