'use client'

import { useId, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { MAX_INSTRUCTION_CHARS } from '@/lib/gtm/manager/instructions'
import type { UnmetTally } from '@/lib/gtm/manager/instructions'
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
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <Button type="button" variant="primary" className="w-full sm:w-auto" disabled={pending || text.trim().length === 0} onClick={send}>
          {pending ? 'Sending...' : 'Send to the manager'}
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
        {item.source === 'manager' && <Badge tone="blue">Manager&apos;s plan</Badge>}
        <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>{age}</span>
      </div>
      <p className="text-sm mt-1" style={{ color: 'var(--text-primary)' }}>{item.instruction}</p>
      {item.reply && <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{item.reply}</p>}
      {item.proposal.length > 0 && item.status === 'proposed' && (
        <ul className="mt-2 list-disc pl-5 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {item.proposal.map((a) => <li key={`${a.kind}-${a.params.team ?? ''}`}>{a.summary}</li>)}
        </ul>
      )}
      {item.unmet.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Not covered by anything it can do yet:</p>
          <ul className="mt-1 list-disc pl-5 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {item.unmet.map((u) => <li key={u}>{u}</li>)}
          </ul>
        </div>
      )}
      {item.outcomes.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {item.outcomes.map((o) => <li key={o}>{o}</li>)}
        </ul>
      )}
      {item.status === 'proposed' && (
        <div className="mt-3 flex gap-2">
          <Button type="button" variant="primary" className="grow sm:grow-0" disabled={pending} onClick={() => decide('approve')}>Approve</Button>
          <Button type="button" variant="danger" className="grow sm:grow-0" disabled={pending} onClick={() => decide('reject')}>Reject</Button>
        </div>
      )}
      {error && <p role="alert" className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>}
    </li>
  )
}

function learnedText(item: PlaybookItem): string {
  const times = item.approved === 1 ? 'time' : 'times'
  const rejected = item.rejected > 0 ? ` and rejected it ${item.rejected}` : ''
  return `You have approved this ${item.approved} ${times}${rejected}.`
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
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
        {item.standing ? `Handed over. ${item.trigger}` : `If you hand it over: ${item.trigger}`} It holds back while 10 or more items wait for you.
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
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

function UnmetList({ items }: Readonly<{ items: UnmetTally[] }>) {
  if (items.length === 0) return null
  return (
    <div className="mt-4">
      <h4 className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>Asked for, but it cannot do yet</h4>
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
        Parts of your replies that no action covers. Repeats of the same words are counted. This is the list of what to build next.
      </p>
      <ul className="mt-2 list-disc pl-5 text-sm" style={{ color: 'var(--text-secondary)' }}>
        {items.map((u) => <li key={u.request}>{u.request}{u.count > 1 ? ` (${u.count} times)` : ''}</li>)}
      </ul>
    </div>
  )
}

export function ManagerInstructions({
  briefId, instructions, playbook, unmetRequests, ages,
}: Readonly<{
  briefId: string | null
  instructions: InstructionItem[]
  playbook: PlaybookItem[]
  unmetRequests: UnmetTally[]
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

      <UnmetList items={unmetRequests} />

      <details className="mt-5" open={playbook.some((p) => p.offered || p.standing)}>
        <summary className="text-xs font-semibold cursor-pointer" style={{ color: 'var(--text-primary)' }}>
          What the manager can do, and what it has learned
        </summary>
        <ul>{playbook.map((p) => <PlaybookRow key={p.kind} item={p} />)}</ul>
      </details>
    </Card>
  )
}
