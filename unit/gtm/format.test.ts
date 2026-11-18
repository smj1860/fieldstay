import { describe, it, expect } from 'vitest'
import { formatCents, previewOutput, taskStatusTone, timeAgo } from '@/lib/gtm/format'
import { TASK_STATUSES } from '@/lib/gtm/constants'

describe('previewOutput', () => {
  it('shows a draft as prose: the subject labelled, the body as written', () => {
    expect(previewOutput({ subject: 'Quick question', body: 'Hi Dana,\nAre you...' })).toBe('subject: Quick question\n\nHi Dana,\nAre you...')
  })

  // Hiding fields a reviewer ought to see is worse than showing them untidily.
  it('falls back to the raw JSON when there is no recognised prose field', () => {
    expect(previewOutput({ score: 7, reasons: ['a'] })).toContain('"score": 7')
  })

  it('says so when there is no output at all', () => {
    expect(previewOutput(null)).toBe('(no output recorded)')
    expect(previewOutput(undefined)).toBe('(no output recorded)')
  })

  it('truncates a runaway output', () => {
    const out = previewOutput({ body: 'x'.repeat(5_000) })
    expect(out.length).toBeLessThan(1_300)
    expect(out.endsWith('(truncated)')).toBe(true)
  })

  it('ignores a blank subject', () => {
    expect(previewOutput({ subject: '   ', body: 'hello' })).toBe('hello')
  })
})

describe('timeAgo', () => {
  const now = new Date('2026-11-18T12:00:00Z')
  it.each([
    ['2026-11-18T11:59:30Z', 'just now'],
    ['2026-11-18T11:55:00Z', '5m ago'],
    ['2026-11-18T09:00:00Z', '3h ago'],
    ['2026-11-15T12:00:00Z', '3d ago'],
  ])('%s is %s', (iso, expected) => {
    expect(timeAgo(iso, now)).toBe(expected)
  })

  it('does not print NaN for a bad timestamp', () => {
    expect(timeAgo('not a date', now)).toBe('just now')
  })
})

describe('formatCents / taskStatusTone', () => {
  it('formats cents, including fractions of one', () => {
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(1234)).toBe('$12.34')
    expect(formatCents(0.35)).toBe('$0.00')
    expect(formatCents(-5)).toBe('$0.00')
  })

  it('gives every status a tone, and flags the ones that need a person', () => {
    for (const s of TASK_STATUSES) expect(taskStatusTone(s)).toBeTruthy()
    expect(taskStatusTone('needs_approval')).toBe('amber')
    expect(taskStatusTone('failed')).toBe('red')
  })
})
