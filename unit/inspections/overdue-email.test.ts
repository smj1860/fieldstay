import { describe, it, expect } from 'vitest'
import {
  firstOfMonth,
  groupByOrg,
  selectOverdueForDigest,
  type OverdueCandidate,
} from '@/lib/inspections/overdue-email'
import {
  bulkOverdueCopy,
  singleOverdueCopy,
  type OverdueLine,
} from '@/lib/inspections/overdue-email-copy'

// ============================================================================
// THE OVERDUE DIGEST'S TWO DECISIONS: WHEN, AND WHO GETS BUNDLED.
//
// WHEN. The 1st of each month, covering everything due in a PRIOR month.
// Inspection due dates cluster by month rather than by day: applySafetyTemplate
// seeds every property with the 1st of the template's month — literally the
// same date — and from the second occurrence onward nudgeDueDateIntoVacancy
// moves each to a different day inside roughly that month, picked from that
// property's own booking gaps. A per-due-date rule would trickle emails across
// the month instead of sending one.
//
// WHO. One email per ORG, listing everything outstanding.
//
// The dedupe key is the DIGEST MONTH, not the occurrence, which is what makes a
// schedule that stays overdue reappear next month rather than going quiet while
// the problem persists.
// ============================================================================

// The 1st, which is when the digest runs.
const RUN_DATE = '2026-10-01'

const candidate = (over: Partial<OverdueCandidate> = {}): OverdueCandidate => ({
  id:                     'sched-1',
  org_id:                 'org-1',
  property_id:            'prop-1',
  next_due_date:          '2026-09-12',   // last month
  overdue_notified_month: null,
  ...over,
})

describe('selectOverdueForDigest — when', () => {
  const ids = (due: string, run = RUN_DATE) =>
    selectOverdueForDigest([candidate({ next_due_date: due })], run).map((r) => r.id)

  it('reports a prior month, and not the month in progress', () => {
    expect(ids('2026-09-30'), 'last day of last month').toEqual(['sched-1'])
    expect(ids('2026-09-01'), 'first day of last month').toEqual(['sched-1'])
    expect(ids('2026-06-15'), 'months ago, still outstanding').toEqual(['sched-1'])

    expect(ids('2026-10-01'), 'due today — this month is not over').toEqual([])
    expect(ids('2026-10-20'), 'due later this month').toEqual([])
  })

  it('does not report a walk missed earlier in the SAME month', () => {
    // The accepted cost of a monthly digest, asserted so it is a decision
    // rather than a surprise: a walk missed on the 2nd waits for the 1st of the
    // next month. The dashboard styles it overdue from day one, so this is the
    // escalation being monthly, not the only signal being monthly.
    expect(ids('2026-10-02', '2026-10-20')).toEqual([])
  })

  it('reports the day count the copy prints', () => {
    const [row] = selectOverdueForDigest([candidate({ next_due_date: '2026-09-21' })], RUN_DATE)
    expect(row!.daysOverdue).toBe(10)
  })

  it('ignores a schedule with no due date', () => {
    expect(selectOverdueForDigest([candidate({ next_due_date: null })], RUN_DATE)).toEqual([])
  })

  it('keeps whatever else the caller selected', () => {
    // The cron reads the schedule name and a property embed to build the email.
    // A non-generic return type erased both — the rows still carried them at
    // runtime, so nothing here would have failed; it surfaced only as a type
    // error at the far end.
    const rows = selectOverdueForDigest(
      [{ ...candidate(), name: 'Safety Inspection', property: [{ name: 'Lake House' }] }],
      RUN_DATE,
    )
    expect(rows[0]!.name).toBe('Safety Inspection')
    expect(rows[0]!.property).toEqual([{ name: 'Lake House' }])
  })

  it('identifies a digest by the first of its month', () => {
    expect(firstOfMonth('2026-10-01')).toBe('2026-10-01')
    expect(firstOfMonth('2026-10-31')).toBe('2026-10-01')
  })
})

describe('selectOverdueForDigest — once per month, but every month', () => {
  it('skips a schedule already in THIS month\u2019s digest', () => {
    expect(selectOverdueForDigest(
      [candidate({ overdue_notified_month: '2026-10-01' })],
      RUN_DATE,
    )).toEqual([])
  })

  it('reports it AGAIN next month while it is still outstanding', () => {
    // The point of a digest, and the difference from the per-occurrence key
    // this replaced: a schedule nobody has walked does not go quiet after one
    // email. It reappears every month until it is done.
    expect(selectOverdueForDigest(
      [candidate({ overdue_notified_month: '2026-10-01' })],
      '2026-11-01',
    ).map((r) => r.id)).toEqual(['sched-1'])
  })

  it('reports one reported in an earlier month', () => {
    expect(selectOverdueForDigest(
      [candidate({ overdue_notified_month: '2026-08-01' })],
      RUN_DATE,
    ).map((r) => r.id)).toEqual(['sched-1'])
  })
})

describe('groupByOrg — one email per org', () => {
  it('bundles a whole portfolio into a single group', () => {
    // The scenario that forces this: applySafetyTemplate gives every property
    // the 1st of the template's month, so a whole portfolio's FIRST occurrence
    // really is one shared date. Later occurrences scatter across the month via
    // the vacancy nudge — which the monthly digest also collapses into one
    // email, for a different reason.
    const rows = selectOverdueForDigest(
      Array.from({ length: 29 }, (_, i) =>
        candidate({ id: `s${i}`, property_id: `p${i}`, next_due_date: '2026-09-01' })),
      RUN_DATE,
    )

    const byOrg = groupByOrg(rows)
    expect(byOrg.size).toBe(1)
    expect(byOrg.get('org-1')).toHaveLength(29)
  })

  it('keeps tenants apart', () => {
    const rows = selectOverdueForDigest([
      candidate({ id: 'a', org_id: 'org-1' }),
      candidate({ id: 'b', org_id: 'org-2' }),
      candidate({ id: 'c', org_id: 'org-1' }),
    ], RUN_DATE)

    const byOrg = groupByOrg(rows)
    expect([...byOrg.keys()]).toEqual(['org-1', 'org-2'])
    expect(byOrg.get('org-1')!.map((r) => r.id)).toEqual(['a', 'c'])
  })
})

// ── Copy ─────────────────────────────────────────────────────────────────────

const line = (over: Partial<OverdueLine> = {}): OverdueLine => ({
  propertyName: 'Lake House',
  formLabel:    'Safety Inspection',
  dueDate:      'September 12, 2026',
  daysOverdue:  3,
  ...over,
})

describe('overdue email copy', () => {
  it('says the things §9 requires', () => {
    const copy = singleOverdueCopy('Dana', line())
    expect(copy.body).toContain('Lake House')
    expect(copy.body).toContain('September 12, 2026')
    expect(copy.body).toContain('3 days overdue')
    expect(copy.body).toContain('owner portal')
  })

  it('does NOT predict what an insurer will do', () => {
    // §9's hard constraint, and the reason the approved copy replaced a draft.
    // Asserted as a test rather than trusted to review, because the sentence
    // that crosses this line is always the one that sounds most persuasive.
    const bodies = [
      singleOverdueCopy('Dana', line()).body,
      bulkOverdueCopy('Dana', [line(), line()]).body,
    ]

    const FORBIDDEN = [
      /may not (be )?cover/i,
      /deny|denied|denial/i,
      /void(ing)? (your )?(policy|coverage)/i,
      /coverage standard/i,
      /jeopardi[sz]e/i,
      /non-?complian|out of compliance|full compliance/i,
      /unmonitored hazard/i,
    ]

    for (const body of bodies) {
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(body), `copy must not match ${pattern}`).toBe(false)
      }
    }
  })

  it('singularises a one-day count', () => {
    expect(singleOverdueCopy('Dana', line({ daysOverdue: 1 })).body).toContain('1 day overdue')
  })

  it('switches to the bulk variant without changing the argument', () => {
    // The bulk copy is a MECHANICAL derivation of what was approved — same
    // reasoning paragraph, same call to action, same support line. This is what
    // notices if the two ever drift into making different claims.
    const single = singleOverdueCopy('Dana', line())
    const bulk   = bulkOverdueCopy('Dana', [line(), line({ propertyName: 'Cabin' })])

    expect(bulk.subject).toContain('2 Overdue')
    expect(bulk.ctaLabel).toBe(single.ctaLabel)
    expect(bulk.note).toBe(single.note)
    expect(bulk.body).toContain('owner portal')
    expect(bulk.body).toContain('gap in that record')
  })
})
