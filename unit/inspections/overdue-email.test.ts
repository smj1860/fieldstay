import { describe, it, expect } from 'vitest'
import {
  OVERDUE_EMAIL_DELAY_DAYS,
  groupByOrg,
  selectOverdueForEmail,
  type OverdueCandidate,
} from '@/lib/inspections/overdue-email'
import {
  bulkOverdueCopy,
  singleOverdueCopy,
  type OverdueLine,
} from '@/lib/inspections/overdue-email-copy'

// ============================================================================
// THE OVERDUE EMAIL'S TWO DECISIONS: WHEN, AND WHO GETS BUNDLED.
//
// Both are load-bearing in ways that are easy to get subtly wrong.
//
// WHEN. Three days after the due date, not on it — a walk due today is not late
// today, and a same-day email teaches the reader that this sender nags.
//
// WHO. One email per ORG. applySafetyTemplate writes one shared first due date
// across every property, so an entire portfolio crosses the line on the same
// morning; per-property would mean 29 emails before breakfast.
//
// And the dedupe comparison is `!==`, never `<`. That distinction has no
// visible symptom until the day a due date moves BACKWARD, which the vacancy
// nudge does deliberately.
// ============================================================================

const TODAY = '2026-09-15'

const candidate = (over: Partial<OverdueCandidate> = {}): OverdueCandidate => ({
  id:                   'sched-1',
  org_id:               'org-1',
  property_id:          'prop-1',
  next_due_date:        '2026-09-12',   // exactly 3 days overdue
  overdue_notified_for: null,
  ...over,
})

describe('selectOverdueForEmail — when', () => {
  it('holds off until the delay has fully elapsed', () => {
    const ids = (d: string) =>
      selectOverdueForEmail([candidate({ next_due_date: d })], TODAY).map((r) => r.id)

    expect(ids('2026-09-15'), 'due today is not late today').toEqual([])
    expect(ids('2026-09-14'), '1 day').toEqual([])
    expect(ids('2026-09-13'), '2 days').toEqual([])
    expect(ids('2026-09-12'), '3 days — the boundary, inclusive').toEqual(['sched-1'])
    expect(ids('2026-06-01'), 'long overdue').toEqual(['sched-1'])
  })

  it('reports the day count the copy prints', () => {
    const [row] = selectOverdueForEmail([candidate({ next_due_date: '2026-09-05' })], TODAY)
    expect(row!.daysOverdue).toBe(10)
  })

  it('ignores a schedule with no due date', () => {
    expect(selectOverdueForEmail([candidate({ next_due_date: null })], TODAY)).toEqual([])
  })

  it('keeps whatever else the caller selected', () => {
    // The cron reads the schedule name and a property embed to build the email.
    // A non-generic return type erased both — the rows still carried them at
    // runtime, so nothing here would have failed; it surfaced only as a type
    // error at the far end.
    const rows = selectOverdueForEmail(
      [{ ...candidate(), name: 'Safety Inspection', property: [{ name: 'Lake House' }] }],
      TODAY,
    )
    expect(rows[0]!.name).toBe('Safety Inspection')
    expect(rows[0]!.property).toEqual([{ name: 'Lake House' }])
  })

  it('states the delay it is built around', () => {
    expect(OVERDUE_EMAIL_DELAY_DAYS).toBe(3)
  })
})

describe('selectOverdueForEmail — once per occurrence', () => {
  it('skips an occurrence already mailed about', () => {
    expect(selectOverdueForEmail(
      [candidate({ next_due_date: '2026-09-12', overdue_notified_for: '2026-09-12' })],
      TODAY,
    )).toEqual([])
  })

  it('mails again once the due date has MOVED, even backwards', () => {
    // The `!==` vs `<` case, and the only one that separates them.
    //
    // Completion advances next_due_date forward, which either comparison
    // handles. But lib/maintenance/vacant-due-date.ts deliberately moves a
    // FUTURE due date EARLIER to land the walk in a gap between bookings — and
    // `overdue_notified_for < next_due_date` would read that as already
    // notified and swallow the email for that occurrence entirely.
    const movedBack = candidate({
      next_due_date:        '2026-09-01',
      overdue_notified_for: '2026-09-12',
    })
    expect(selectOverdueForEmail([movedBack], TODAY).map((r) => r.id)).toEqual(['sched-1'])
  })

  it('mails for a NEW occurrence after a completed one', () => {
    expect(selectOverdueForEmail(
      [candidate({ next_due_date: '2026-09-10', overdue_notified_for: '2025-09-10' })],
      TODAY,
    ).map((r) => r.id)).toEqual(['sched-1'])
  })
})

describe('groupByOrg — one email per org', () => {
  it('bundles a whole portfolio into a single group', () => {
    // The scenario that forces this: applySafetyTemplate gives every property
    // the same first due date, so they all come due together.
    const rows = selectOverdueForEmail(
      Array.from({ length: 29 }, (_, i) =>
        candidate({ id: `s${i}`, property_id: `p${i}`, next_due_date: '2026-09-10' })),
      TODAY,
    )

    const byOrg = groupByOrg(rows)
    expect(byOrg.size).toBe(1)
    expect(byOrg.get('org-1')).toHaveLength(29)
  })

  it('keeps tenants apart', () => {
    const rows = selectOverdueForEmail([
      candidate({ id: 'a', org_id: 'org-1' }),
      candidate({ id: 'b', org_id: 'org-2' }),
      candidate({ id: 'c', org_id: 'org-1' }),
    ], TODAY)

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
