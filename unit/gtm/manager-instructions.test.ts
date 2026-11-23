import { describe, it, expect } from 'vitest'
import {
  ACTION_KINDS,
  STANDING_HOLD_AT_WAITING,
  cadenceDaysFor,
  checkInstructionText,
  holdStanding,
  lastActivityAt,
  learnFromHistory,
  mayOfferStanding,
  readInterpretation,
  readStoredProposal,
  recordsFromRows,
  standingDue,
  type InstructionRecord,
} from '@/lib/gtm/manager/instructions'

// ============================================================================
// What a reply to the manager is allowed to become, and when the manager may
// offer to take an instruction type over. Every rule here is the thing that
// stands between "a person typed a sentence" and "something got queued", so
// each one is pinned, including the refusals.
// ============================================================================

describe('readInterpretation', () => {
  it('keeps catalog actions and writes the summary itself', () => {
    const out = readInterpretation({
      reply: 'Retrying them.',
      actions: [{ kind: 'requeue_failed', team: 'sales_ops' }],
    })
    expect(out?.actions).toEqual([
      { kind: 'requeue_failed', params: { team: 'sales_ops' }, summary: 'Retry failed tasks (Sales Ops only)' },
    ])
  })

  it('drops an action the model invented', () => {
    const out = readInterpretation({
      reply: 'Sending now.',
      actions: [{ kind: 'send_email_to_all' }, { kind: 'run_funnel_report' }],
    })
    expect(out?.actions.map((a) => a.kind)).toEqual(['run_funnel_report'])
  })

  it('ignores a team on an action that takes none, and a team that does not exist', () => {
    const out = readInterpretation({
      reply: 'ok',
      actions: [{ kind: 'run_funnel_report', team: 'lead_gen' }, { kind: 'requeue_failed', team: 'accounting' }],
    })
    expect(out?.actions).toEqual([
      { kind: 'run_funnel_report', params: {}, summary: 'Write the funnel report' },
      { kind: 'requeue_failed', params: {}, summary: 'Retry failed tasks' },
    ])
  })

  it('collapses repeats of the same action', () => {
    const out = readInterpretation({
      reply: 'ok',
      actions: [{ kind: 'run_funnel_report' }, { kind: 'run_funnel_report' }],
    })
    expect(out?.actions).toHaveLength(1)
  })

  it('never carries an em dash into the reply a person reads', () => {
    expect(readInterpretation({ reply: 'Done — retrying.', actions: [] })?.reply).toBe('Done , retrying.')
  })

  it('reads nothing from an answer that is the wrong shape', () => {
    expect(readInterpretation(null)).toBeNull()
    expect(readInterpretation({ reply: 'x' })).toBeNull()
    expect(readInterpretation({ reply: 5, actions: [] })).toBeNull()
  })
})

describe('readStoredProposal', () => {
  it('re-validates what is in the column, because a person approves from it', () => {
    expect(readStoredProposal([
      { kind: 'run_funnel_report', params: {}, summary: 'anything the column says' },
      { kind: 'delete_everything', params: {} },
      'junk',
    ])).toEqual([{ kind: 'run_funnel_report', params: {}, summary: 'Write the funnel report' }])
    expect(readStoredProposal(null)).toEqual([])
  })
})

describe('checkInstructionText', () => {
  it('trims, strips control characters, and bounds the length', () => {
    expect(checkInstructionText('  retry them\u0007 ')).toEqual({ text: 'retry them' })
    expect(checkInstructionText('  ')).toHaveProperty('error')
    expect(checkInstructionText('x'.repeat(1001))).toHaveProperty('error')
    expect(checkInstructionText(42)).toHaveProperty('error')
  })
})

function human(status: string, kinds: string[], decidedAt: string | null): InstructionRecord {
  return { source: 'human', status, kinds, decidedAt }
}

describe('learnFromHistory', () => {
  it('counts approvals and rejections per kind, and the days they happened on', () => {
    const [requeue] = learnFromHistory([
      human('applied', ['requeue_failed'], '2026-11-02T15:00:00Z'),
      human('applied', ['requeue_failed'], '2026-11-02T18:00:00Z'),
      human('failed', ['requeue_failed'], '2026-11-04T15:00:00Z'),
      human('rejected', ['requeue_failed'], '2026-11-05T15:00:00Z'),
    ])
    expect(requeue).toMatchObject({ kind: 'requeue_failed', approved: 3, rejected: 1, distinctDays: 2 })
  })

  it('does not count a reply the manager could not read, or one still waiting, as approval', () => {
    const [requeue] = learnFromHistory([
      human('unclear', ['requeue_failed'], null),
      human('proposed', ['requeue_failed'], null),
      human('interpreting', ['requeue_failed'], null),
    ])
    expect(requeue.approved).toBe(0)
  })

  it('learns nothing from its own standing runs', () => {
    const [requeue] = learnFromHistory([
      { source: 'standing', status: 'applied', kinds: ['requeue_failed'], decidedAt: '2026-11-02T15:00:00Z' },
    ])
    expect(requeue.approved).toBe(0)
  })

  it('reads the rhythm from the gaps between days, not between clicks', () => {
    const learned = learnFromHistory([
      human('applied', ['run_funnel_report'], '2026-11-02T15:00:00Z'),
      human('applied', ['run_funnel_report'], '2026-11-02T15:05:00Z'),
      human('applied', ['run_funnel_report'], '2026-11-09T15:00:00Z'),
      human('applied', ['run_funnel_report'], '2026-11-16T15:00:00Z'),
    ]).find((l) => l.kind === 'run_funnel_report')
    expect(learned?.cadenceDays).toBe(7)
  })

  it('has no rhythm until there are two different days, and then falls back to a week', () => {
    const learned = learnFromHistory([human('applied', ['run_funnel_report'], '2026-11-02T15:00:00Z')])
      .find((l) => l.kind === 'run_funnel_report')!
    expect(learned.cadenceDays).toBeNull()
    expect(cadenceDaysFor(learned)).toBe(7)
  })

  it('clamps the rhythm between a day and two weeks', () => {
    const slow = learnFromHistory([
      human('applied', ['run_funnel_report'], '2026-01-01T15:00:00Z'),
      human('applied', ['run_funnel_report'], '2026-06-01T15:00:00Z'),
    ]).find((l) => l.kind === 'run_funnel_report')!
    expect(slow.cadenceDays).toBe(14)
  })

  it('answers for every kind in the catalog, including ones never used', () => {
    expect(learnFromHistory([]).map((l) => l.kind)).toEqual([...ACTION_KINDS])
  })
})

describe('mayOfferStanding', () => {
  const base = { kind: 'requeue_failed' as const, approved: 3, rejected: 0, distinctDays: 2, lastApprovedAt: null, cadenceDays: null }

  it('offers after enough approvals on enough different days with no rejection', () => {
    expect(mayOfferStanding(base)).toBe(true)
  })

  it('does not offer on too few approvals, too few days, or any rejection', () => {
    expect(mayOfferStanding({ ...base, approved: 2 })).toBe(false)
    expect(mayOfferStanding({ ...base, distinctDays: 1 })).toBe(false)
    expect(mayOfferStanding({ ...base, rejected: 1 })).toBe(false)
  })
})

describe('standingDue', () => {
  const now = new Date('2026-11-23T12:30:00Z')

  it('is due when it has never run', () => {
    expect(standingDue({ now, lastRunAt: null, cadenceDays: 7 })).toBe(true)
  })

  it('waits out the cadence, with an hour of slack for a cron that fires early', () => {
    expect(standingDue({ now, lastRunAt: '2026-11-17T12:30:00Z', cadenceDays: 7 })).toBe(false)
    expect(standingDue({ now, lastRunAt: '2026-11-16T12:45:00Z', cadenceDays: 7 })).toBe(true)
    expect(standingDue({ now, lastRunAt: '2026-11-16T12:00:00Z', cadenceDays: 7 })).toBe(true)
  })
})

describe('holdStanding', () => {
  it('holds back while a person already has a pile waiting', () => {
    expect(holdStanding(STANDING_HOLD_AT_WAITING - 1)).toBe(false)
    expect(holdStanding(STANDING_HOLD_AT_WAITING)).toBe(true)
  })
})

describe('lastActivityAt', () => {
  const learned = { kind: 'run_funnel_report' as const, approved: 3, rejected: 0, distinctDays: 3, lastApprovedAt: '2026-11-16T15:00:00Z', cadenceDays: 7 }

  it('counts from whichever is later, the last approval or the last standing run', () => {
    expect(lastActivityAt(learned, '2026-11-20T10:00:00Z')).toBe('2026-11-20T10:00:00.000Z')
    expect(lastActivityAt(learned, null)).toBe('2026-11-16T15:00:00.000Z')
    expect(lastActivityAt({ ...learned, lastApprovedAt: null }, null)).toBeNull()
  })
})

describe('recordsFromRows', () => {
  it('maps rows and drops a source it does not know', () => {
    expect(recordsFromRows([
      { source: 'human', status: 'applied', action_kinds: ['run_funnel_report'], decided_at: null },
      { source: 'robot', status: 'applied', action_kinds: [], decided_at: null },
    ])).toHaveLength(1)
  })
})
