import { describe, it, expect } from 'vitest'
import { MAX_LEAD_GEN_HANDOFFS, buildWeeklyReport, priorWeekTouches, type ReportInput } from '@/lib/gtm/teams/rev-ops-report'

const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  now: new Date('2026-11-16T13:00:00Z'),
  funnel: { new: 100, researching: 20, emailed: 30, replied: 5, meeting_set: 2, in_trial: 1, won: 3, lost: 10, disqualified: 4 },
  touchesThisWeek: { emailed: 40, called: 5, replied: 8 },
  touchesPriorWeek: { emailed: 25, called: 5, replied: 3 },
  staleCount: 14,
  staleExamples: [{ company: 'Acme Rentals', status: 'emailed', daysSinceTouch: 21 }, { company: 'Brook Stays', status: 'meeting_set', daysSinceTouch: null }],
  needsContactInfo: 120, bouncedPrimary: 6, queuedNoChannel: 9,
  enrichCandidates: ['a', 'b', 'c'],
  spendTodayCents: 12.5,
  ...over,
})

describe('buildWeeklyReport', () => {
  const report = buildWeeklyReport(base())

  it('titles the report by its week', () => {
    expect(report.subject).toBe('Weekly funnel report, week of 2026-11-16')
  })

  it('states the pipeline with closed accounts taken out of "in play"', () => {
    expect(report.body).toContain('Pipeline: 175 accounts, 158 in play. 5 replied, 2 meetings set, 1 in trial, 3 won.')
  })

  it('compares this week to last, with the change signed', () => {
    expect(report.body).toContain('40 emailed (+15)')
    expect(report.body).toContain('5 called (no change)')
    expect(report.body).toContain('8 replied (+5)')
  })

  it('reports the reply rate for both weeks', () => {
    expect(report.body).toContain('Reply rate (replies per email sent): 20% this week, 12% last week.')
  })

  it('calls out stalled accounts, longest waiting first, including one never touched', () => {
    expect(report.body).toContain('Stalled: 14 active accounts with no touch in 7+ days.')
    expect(report.body).toContain('Acme Rentals (emailed, 21d); Brook Stays (meeting set, never touched)')
  })

  it('reports data hygiene and spend', () => {
    expect(report.body).toContain('120 need contact info, 6 have a bounced primary email, 9 are queued with no email or phone.')
    expect(report.body).toContain('Agent spend today: $0.13.')
  })

  it('says what approving will do, in plain terms, and that results still come back for approval', () => {
    expect(report.body).toContain('approving this report asks Lead Gen to look for public contact details on 3 accounts')
    expect(report.body).toContain('still comes back here for approval before anything is saved')
  })

  it('carries the figures behind the prose so the report can be checked against a query', () => {
    expect(report.metrics).toMatchObject({ accounts: 175, in_play: 158, stalled: 14, needs_contact_info: 120, emailed_this_week: 40, emailed_last_week: 25 })
  })

  it('puts the handoff ids in the output, which is what approval acts on', () => {
    expect(report.handoff).toEqual({ lead_gen_enrich: ['a', 'b', 'c'] })
  })

  it('caps one approval\'s handoff, so a click cannot queue the whole backlog', () => {
    const many = Array.from({ length: 40 }, (_, i) => `id${i}`)
    expect(buildWeeklyReport(base({ enrichCandidates: many })).handoff.lead_gen_enrich).toHaveLength(MAX_LEAD_GEN_HANDOFFS)
  })

  it('says there is nothing to hand off, rather than offering an empty handoff', () => {
    const r = buildWeeklyReport(base({ enrichCandidates: [] }))
    expect(r.body).toContain('nothing to hand off')
    expect(r.handoff.lead_gen_enrich).toEqual([])
  })

  it('reads a quiet week as quiet, with no NaN, Infinity or divide-by-zero', () => {
    const r = buildWeeklyReport(base({ touchesThisWeek: {}, touchesPriorWeek: {}, staleCount: 0, staleExamples: [], funnel: {} }))
    expect(r.body).toContain('Reply rate (replies per email sent): no emails sent this week, no emails sent last week.')
    expect(r.body).toContain('Stalled: none.')
    expect(r.body).not.toMatch(/NaN|Infinity/)
  })

  it('uses singular for exactly one account', () => {
    const r = buildWeeklyReport(base({ staleCount: 1, enrichCandidates: ['a'] }))
    expect(r.body).toContain('1 active account with')
    expect(r.body).toContain('on 1 account.')
  })

  it('contains no em dash', () => {
    expect(report.body + report.subject).not.toContain('—')
  })
})

describe('priorWeekTouches', () => {
  it('is the 14-day count minus the 7-day count, never negative', () => {
    expect(priorWeekTouches({ emailed: 65, called: 5 }, { emailed: 40, called: 9 })).toEqual({ emailed: 25, called: 0 })
  })

  it('keeps a kind that only appeared in the older window', () => {
    expect(priorWeekTouches({ texted: 4 }, {})).toEqual({ texted: 4 })
  })
})
