import { describe, it, expect } from 'vitest'
import { rankCascadeRisk, type CascadeJob } from '@/lib/scoring/cascade'

const NOW = Date.parse('2026-10-13T16:00:00.000Z')

/** ~24km apart: a 30-minute drive at the shared 48km/h estimate. */
const A = { lat: 32.50, lng: -85.90 }
const B = { lat: 32.50, lng: -85.64 }

const job = (over: Partial<CascadeJob> & { turnoverId: string }): CascadeJob => ({
  propertyName:    over.turnoverId,
  startAt:         '2026-10-13T13:00:00.000Z',
  checkinAt:       '2026-10-13T15:00:00.000Z',
  lat: null, lng: null,
  durationMinutes: 120,
  completionRatio: 0.5,
  ...over,
})

describe('rankCascadeRisk — what counts as late', () => {
  it('reports a job past its check-in with work still to do', () => {
    const [risk] = rankCascadeRisk([job({ turnoverId: 't1' })], NOW)
    expect(risk!.turnoverId).toBe('t1')
    expect(risk!.minutesLate).toBe(60)
  })

  it('ignores a job that has not reached its check-in', () => {
    expect(rankCascadeRisk([job({
      turnoverId: 't1', checkinAt: '2026-10-13T18:00:00.000Z',
    })], NOW)).toEqual([])
  })

  // A finished job that ran long is history, not a cascade.
  it('ignores a job that is already complete', () => {
    expect(rankCascadeRisk([job({ turnoverId: 't1', completionRatio: 1 })], NOW)).toEqual([])
  })

  // No incoming guest means no deadline to be late against. Treating an absent
  // check-in as one would flag every quiet standalone turnover.
  it('ignores a standalone turnover with no incoming guest', () => {
    expect(rankCascadeRisk([job({ turnoverId: 't1', checkinAt: null })], NOW)).toEqual([])
  })

  it('ignores a job whose check-in cannot be parsed', () => {
    expect(rankCascadeRisk([job({ turnoverId: 't1', checkinAt: 'not-a-date' })], NOW)).toEqual([])
  })
})

describe('rankCascadeRisk — projected overrun', () => {
  // The number the whole feature turns on: remaining work, plus travel and the
  // arrival buffer, measured against when the next job is due to start.
  it('projects remaining work plus travel into the next job', () => {
    const [risk] = rankCascadeRisk([
      job({ turnoverId: 'late', durationMinutes: 120, completionRatio: 0.5, ...A }),
      job({ turnoverId: 'next', startAt: '2026-10-13T16:30:00.000Z', checkinAt: null, ...B }),
    ], NOW)

    // 60 min of work left, +30 travel, +10 buffer = arrives 17:40 for a 16:30
    // start, so 70 minutes into it.
    expect(risk!.overrunMinutes).toBe(70)
    expect(risk!.hasDownstream).toBe(true)
    expect(risk!.nextTurnoverId).toBe('next')
  })

  it('reports no overrun when the next job still starts on time', () => {
    const [risk] = rankCascadeRisk([
      job({ turnoverId: 'late', durationMinutes: 60, completionRatio: 0.9 }),
      job({ turnoverId: 'next', startAt: '2026-10-13T20:00:00.000Z', checkinAt: null }),
    ], NOW)
    expect(risk!.overrunMinutes).toBe(0)
    expect(risk!.hasDownstream).toBe(true)
  })

  // Being late with nothing after it costs nobody else their window. Still
  // reported — it is the crew member's own problem — but it cannot outrank a
  // job that is pushing someone else's day.
  it('reports a late last job of the day with no downstream', () => {
    const [risk] = rankCascadeRisk([job({ turnoverId: 'only' })], NOW)
    expect(risk!.hasDownstream).toBe(false)
    expect(risk!.overrunMinutes).toBe(0)
    expect(risk!.nextTurnoverId).toBeNull()
  })

  // A null ratio is no checklist instance yet, which is NO INFORMATION rather
  // than zero progress. Treated pessimistically on purpose: under-reporting a
  // cascade is the failure that matters.
  it('assumes nothing is done when there is no checklist yet', () => {
    const [withNull] = rankCascadeRisk([
      job({ turnoverId: 'late', durationMinutes: 120, completionRatio: null }),
      job({ turnoverId: 'next', startAt: '2026-10-13T16:30:00.000Z', checkinAt: null }),
    ], NOW)
    const [halfDone] = rankCascadeRisk([
      job({ turnoverId: 'late', durationMinutes: 120, completionRatio: 0.5 }),
      job({ turnoverId: 'next', startAt: '2026-10-13T16:30:00.000Z', checkinAt: null }),
    ], NOW)
    expect(withNull!.overrunMinutes).toBeGreaterThan(halfDone!.overrunMinutes)
  })
})

describe('rankCascadeRisk — travel', () => {
  it('adds drive time between distant stops', () => {
    const near = rankCascadeRisk([
      job({ turnoverId: 'late', ...A }),
      job({ turnoverId: 'next', startAt: '2026-10-13T16:30:00.000Z', checkinAt: null, ...A }),
    ], NOW)
    const far = rankCascadeRisk([
      job({ turnoverId: 'late', ...A }),
      job({ turnoverId: 'next', startAt: '2026-10-13T16:30:00.000Z', checkinAt: null, ...B }),
    ], NOW)
    expect(far[0]!.overrunMinutes).toBeGreaterThan(near[0]!.overrunMinutes)
  })

  // 17/59 live properties have coordinates. A fabricated drive time would move
  // the ranking on data we do not have, so it contributes zero AND says so.
  it('contributes zero travel when coordinates are missing, and flags it', () => {
    const [risk] = rankCascadeRisk([
      job({ turnoverId: 'late', lat: null, lng: null }),
      job({ turnoverId: 'next', startAt: '2026-10-13T16:30:00.000Z', checkinAt: null, ...B }),
    ], NOW)
    expect(risk!.travelUnknown).toBe(true)
  })

  it('does not flag travel as unknown when both ends have coordinates', () => {
    const [risk] = rankCascadeRisk([
      job({ turnoverId: 'late', ...A }),
      job({ turnoverId: 'next', startAt: '2026-10-13T16:30:00.000Z', checkinAt: null, ...B }),
    ], NOW)
    expect(risk!.travelUnknown).toBe(false)
  })
})

describe('rankCascadeRisk — ordering', () => {
  it('ranks by overrun first, worst leading', () => {
    const risks = rankCascadeRisk([
      job({ turnoverId: 'mild',  durationMinutes: 30,  completionRatio: 0.9 }),
      job({ turnoverId: 'mildNext', startAt: '2026-10-13T19:00:00.000Z', checkinAt: null }),
      job({ turnoverId: 'bad',   startAt: '2026-10-13T13:30:00.000Z', durationMinutes: 240, completionRatio: 0.1 }),
      job({ turnoverId: 'badNext',  startAt: '2026-10-13T16:15:00.000Z', checkinAt: null }),
    ], NOW)
    expect(risks[0]!.turnoverId).toBe('bad')
  })

  // The tiebreak. Two jobs eating equally into the next are ordered by how
  // long they have already been over, which is the thing a PM can see.
  //
  // A real tie has to be constructed, not wished for: 'a' has 30 minutes of
  // work left against a next start 150 minutes ago, 'b' has 90 against one 60
  // minutes ago, so both project the same overrun while 'b' is four times as
  // far past its own guest. The equality is asserted rather than assumed,
  // because a fixture that merely LOOKS tied tests the sort's first term.
  it('breaks a tie on how late the job already is', () => {
    const risks = rankCascadeRisk([
      job({
        turnoverId: 'a', startAt: '2026-10-13T13:00:00.000Z',
        checkinAt: '2026-10-13T15:30:00.000Z', durationMinutes: 60,
      }),
      job({
        turnoverId: 'b', startAt: '2026-10-13T14:00:00.000Z',
        checkinAt: '2026-10-13T14:00:00.000Z', durationMinutes: 180,
      }),
      job({ turnoverId: 'tail', startAt: '2026-10-13T15:00:00.000Z', checkinAt: null }),
    ], NOW)

    expect(risks.map((r) => r.overrunMinutes)).toEqual([160, 160])
    expect(risks.map((r) => r.minutesLate)).toEqual([120, 30])
    expect(risks[0]!.turnoverId).toBe('b')
  })

  it('sorts by clock time, not caller array order', () => {
    const risks = rankCascadeRisk([
      job({ turnoverId: 'second', startAt: '2026-10-13T15:00:00.000Z', checkinAt: null }),
      job({ turnoverId: 'first',  startAt: '2026-10-13T13:00:00.000Z' }),
    ], NOW)
    expect(risks[0]!.nextTurnoverId).toBe('second')
  })

  it('returns nothing for an empty day', () => {
    expect(rankCascadeRisk([], NOW)).toEqual([])
  })
})
