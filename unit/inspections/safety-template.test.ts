import { describe, it, expect } from 'vitest'
import {
  describeSafetyTemplate,
  firstSafetyDueDate,
  readSafetyTemplate,
  rebasedSafetyDueDate,
  templateMonths,
  type SafetyTemplate,
} from '@/lib/inspections/safety-template'

// ============================================================================
// THE SAFETY TEMPLATE — one onboarding answer, applied to every property.
//
// §2 puts inspection frequency in onboarding, but a maintenance_schedules row
// is per PROPERTY. Safety is the only form that belongs at org level because
// it is the only one that runs everywhere; the template is the rule, and the
// date it produces is what each property's schedule carries.
//
// The month lives on the TEMPLATE, which is why it is not the dropped
// month_due: that column sat on the schedule alongside next_due_date and could
// disagree with it. A template has no due date at all.
// ============================================================================

const t = (frequency: 'annual' | 'semi_annual', startMonth: number): SafetyTemplate =>
  ({ frequency, startMonth })

/** A fixed UTC instant, so "today" never depends on when CI runs. */
const on = (iso: string) => new Date(`${iso}T12:00:00Z`)

describe('templateMonths', () => {
  it('annual runs in one month', () => {
    expect(templateMonths(t('annual', 3))).toEqual([3])
  })

  it('semi-annual derives the second month six months on', () => {
    expect(templateMonths(t('semi_annual', 3))).toEqual([3, 9])
  })

  it('wraps across the year end and stays ascending', () => {
    // October + 6 is April, which is EARLIER in the calendar. Returning
    // [10, 4] would make firstSafetyDueDate's "first month at or after today"
    // scan pick October for a January date and skip April entirely.
    expect(templateMonths(t('semi_annual', 10))).toEqual([4, 10])
    expect(templateMonths(t('semi_annual', 12))).toEqual([6, 12])
    expect(templateMonths(t('semi_annual', 7))).toEqual([1, 7])
  })

  it('June and December are each other’s pair', () => {
    expect(templateMonths(t('semi_annual', 6))).toEqual([6, 12])
  })
})

describe('firstSafetyDueDate', () => {
  it('is the 1st of the chosen month later this year', () => {
    expect(firstSafetyDueDate(t('annual', 9), on('2026-03-15'))).toBe('2026-09-01')
  })

  it('is THIS month when the PM picks the month they are in', () => {
    // Inclusive on purpose. A PM answering "March" in March means this March;
    // making them wait eleven months for the first walk would be a strange
    // reading of the answer they gave.
    expect(firstSafetyDueDate(t('annual', 3), on('2026-03-28'))).toBe('2026-03-01')
  })

  it('rolls to next year once every run month is behind us', () => {
    expect(firstSafetyDueDate(t('annual', 3), on('2026-07-01'))).toBe('2027-03-01')
  })

  it('semi-annual picks whichever of its two months comes next', () => {
    const march = t('semi_annual', 3)   // March and September
    expect(firstSafetyDueDate(march, on('2026-01-10'))).toBe('2026-03-01')
    expect(firstSafetyDueDate(march, on('2026-05-10'))).toBe('2026-09-01')
    expect(firstSafetyDueDate(march, on('2026-11-10'))).toBe('2027-03-01')
  })

  it('a wrapped pair resumes at the EARLIER month next year', () => {
    // October start → April and October. In November both are behind us, and
    // the next one is April, not October.
    expect(firstSafetyDueDate(t('semi_annual', 10), on('2026-11-05'))).toBe('2027-04-01')
  })

  it('pads the month, so the string sorts and compares correctly', () => {
    // next_due_date is compared as a STRING throughout (selectDueSchedules,
    // the PostgREST filters). '2026-3-01' would sort after '2026-12-01'.
    expect(firstSafetyDueDate(t('annual', 3), on('2026-01-01'))).toBe('2026-03-01')
  })
})

describe('rebasedSafetyDueDate', () => {
  it('never lands in the past, which is the whole reason it is not firstSafetyDueDate', () => {
    // firstSafetyDueDate counts from today's MONTH inclusive, so on March 20th
    // with a March template it returns March 1st — correct for a property being
    // scheduled for the first time, and wrong for re-basing an existing one:
    // the schedule would come back already overdue for a walk nobody was told
    // about.
    expect(firstSafetyDueDate(t('annual', 3),   on('2026-03-20'))).toBe('2026-03-01')
    expect(rebasedSafetyDueDate(t('annual', 3), on('2026-03-20'))).toBe('2027-03-01')
  })

  it('keeps the 1st when today IS the 1st', () => {
    // >= today, not > today. Re-basing on the morning of the 1st should land on
    // that day, not skip a whole cycle.
    expect(rebasedSafetyDueDate(t('annual', 3), on('2026-03-01'))).toBe('2026-03-01')
  })

  it('picks the nearer of a semi-annual pair', () => {
    const march = t('semi_annual', 3)   // March and September
    expect(rebasedSafetyDueDate(march, on('2026-04-10'))).toBe('2026-09-01')
    expect(rebasedSafetyDueDate(march, on('2026-09-02'))).toBe('2027-03-01')
  })

  it('crosses the year end when nothing is left in this one', () => {
    // The case the two-year candidate list exists for: a December template
    // re-based on December 2nd has no remaining date this year.
    expect(rebasedSafetyDueDate(t('annual', 12), on('2026-12-02'))).toBe('2027-12-01')
    expect(rebasedSafetyDueDate(t('semi_annual', 12), on('2026-12-02'))).toBe('2027-06-01')
  })
})

describe('readSafetyTemplate', () => {
  it('reads a complete template', () => {
    expect(readSafetyTemplate({
      inspection_safety_frequency: 'semi_annual', inspection_safety_start_month: 4,
    })).toEqual({ frequency: 'semi_annual', startMonth: 4 })
  })

  it('is null when unanswered', () => {
    expect(readSafetyTemplate({
      inspection_safety_frequency: null, inspection_safety_start_month: null,
    })).toBeNull()
  })

  it('is null for a HALF-answered row, which the CHECK should have prevented', () => {
    // Belt and braces on purpose: the DB constraint is the proof, this is the
    // claim. And the constraint written the obvious way actually DID admit this
    // row — `false OR UNKNOWN` is UNKNOWN, which a CHECK accepts — so the shape
    // is not hypothetical, it existed for one migration.
    expect(readSafetyTemplate({
      inspection_safety_frequency: 'annual', inspection_safety_start_month: null,
    })).toBeNull()
    expect(readSafetyTemplate({
      inspection_safety_frequency: null, inspection_safety_start_month: 4,
    })).toBeNull()
  })

  it('rejects a cadence that is not one of the two', () => {
    // schedule_frequency is shared with work-order schedules, which run weekly.
    // A weekly SAFETY walk is not a thing, and the column type cannot say so.
    expect(readSafetyTemplate({
      inspection_safety_frequency: 'weekly', inspection_safety_start_month: 4,
    })).toBeNull()
  })

  it('rejects an out-of-range month', () => {
    expect(readSafetyTemplate({
      inspection_safety_frequency: 'annual', inspection_safety_start_month: 0,
    })).toBeNull()
    expect(readSafetyTemplate({
      inspection_safety_frequency: 'annual', inspection_safety_start_month: 13,
    })).toBeNull()
  })
})

describe('describeSafetyTemplate', () => {
  it('reads the derived second month back to the PM', () => {
    // The whole point of the summary line on the onboarding step: someone who
    // picks March needs to see September BEFORE they commit, not discover it
    // later on the Maintenance board.
    expect(describeSafetyTemplate(t('semi_annual', 3))).toBe('Twice a year — March and September')
    expect(describeSafetyTemplate(t('annual', 11))).toBe('Once a year — November')
    expect(describeSafetyTemplate(t('semi_annual', 10))).toBe('Twice a year — April and October')
  })
})
