import type { Json } from '@/types/database.generated'
import type { TaskStatus } from './constants'

/** Display helpers for the Agents dashboard. Pure, so the rules are pinned by tests. */

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'gold' | 'purple' | 'slate'

export function taskStatusTone(status: TaskStatus): Tone {
  switch (status) {
    case 'in_progress':    return 'blue'
    case 'needs_approval': return 'amber'
    case 'approved':
    case 'done':           return 'green'
    case 'rejected':
    case 'failed':         return 'red'
    default:               return 'slate'
  }
}

/** Whole dollars and cents, from a cent amount that may be fractional. */
export function formatCents(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`
}

/** "5m ago", "3h ago", "2d ago". Anything under a minute is "just now". */
export function timeAgo(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const PREVIEW_LIMIT = 1_200
const PREVIEW_KEYS = ['subject', 'body', 'summary', 'proposal', 'note'] as const

function isObject(value: Json | undefined): value is { [key: string]: Json | undefined } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * What a reviewer reads before approving. A draft usually carries a subject and
 * a body, so those are shown as prose; anything else falls back to the raw JSON
 * rather than hiding fields the reviewer ought to see. Always truncated: a
 * runaway output must not turn the inbox into a wall of text.
 */
export function previewOutput(output: Json | null | undefined): string {
  if (output === null || output === undefined) return '(no output recorded)'
  let text: string
  if (isObject(output)) {
    const prose = PREVIEW_KEYS
      .map((key) => ({ key, value: output[key] }))
      .filter((p): p is { key: (typeof PREVIEW_KEYS)[number]; value: string } => typeof p.value === 'string' && p.value.trim() !== '')
    text = prose.length > 0
      ? prose.map((p) => (p.key === 'body' ? p.value : `${p.key}: ${p.value}`)).join('\n\n')
      : JSON.stringify(output, null, 2)
  } else {
    text = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
  }
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n... (truncated)` : text
}
