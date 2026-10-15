import { describe, it, expect } from 'vitest'
import {
  claimDeadline, daysBetween, deadlineDedupeKey, deadlineNotice, localDate, stageFor, addDays,
} from '@/lib/evidence/packet/deadlines'

describe('claimDeadline', () => {
  it('Airbnb: 14 days after checkout when no guest arrives sooner', () => {
    expect(claimDeadline({ source: 'airbnb', checkoutDate: '2026-10-10', nextCheckinDate: null, claimWindowDays: 30 }))
      .toEqual({ deadlineDate: '2026-10-24', basis: 'airbnb_checkout_window' })
    expect(claimDeadline({ source: 'airbnb', checkoutDate: '2026-10-10', nextCheckinDate: '2026-11-20', claimWindowDays: 30 }).basis)
      .toBe('airbnb_checkout_window')
  })
  it('Airbnb: before the next check-in when that is sooner', () => {
    expect(claimDeadline({ source: 'airbnb', checkoutDate: '2026-10-10', nextCheckinDate: '2026-10-14', claimWindowDays: 30 }))
      .toEqual({ deadlineDate: '2026-10-13', basis: 'airbnb_before_next_checkin' })
  })
  it('Airbnb: a same-day turnover leaves exactly the checkout day', () => {
    expect(claimDeadline({ source: 'airbnb', checkoutDate: '2026-10-10', nextCheckinDate: '2026-10-10', claimWindowDays: 30 }))
      .toEqual({ deadlineDate: '2026-10-10', basis: 'airbnb_before_next_checkin' })
  })
  it('VRBO uses its own window and ignores the org setting', () => {
    expect(claimDeadline({ source: 'vrbo', checkoutDate: '2026-10-10', nextCheckinDate: '2026-10-11', claimWindowDays: 3 }))
      .toEqual({ deadlineDate: '2026-10-24', basis: 'vrbo_checkout_window' })
  })
  it('everything else uses the org claim window', () => {
    for (const source of ['direct', 'manual', 'booking_com', 'ownerrez', 'other', null]) {
      expect(claimDeadline({ source, checkoutDate: '2026-10-10', nextCheckinDate: null, claimWindowDays: 21 }))
        .toEqual({ deadlineDate: '2026-10-31', basis: 'org_claim_window' })
    }
  })
})

describe('date helpers', () => {
  it('counts calendar days and rolls over month and year ends', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
    expect(daysBetween('2026-10-10', '2026-10-17')).toBe(7)
    expect(daysBetween('2026-10-10', '2026-10-09')).toBe(-1)
  })
  it('reads today in the property timezone, not UTC', () => {
    const lateEveningChicago = Date.parse('2026-10-11T03:30:00Z')   // Oct 10, 10:30pm CDT
    expect(localDate(lateEveningChicago, 'America/Chicago')).toBe('2026-10-10')
    expect(localDate(lateEveningChicago, 'UTC')).toBe('2026-10-11')
    expect(localDate(lateEveningChicago, 'Not/AZone')).toBe('2026-10-11')
  })
})

describe('stageFor', () => {
  it.each([[30, 'opened'], [8, 'opened'], [7, 'd7'], [3, 'd7'], [2, 'd2'], [0, 'd2'], [-1, 'expired']] as const)(
    '%i days left is %s', (days, stage) => expect(stageFor(days)).toBe(stage))
})

describe('notices', () => {
  const base = { propertyName: 'Lake House', deadlineDate: '2026-10-24', basis: 'airbnb_checkout_window' as const }
  it('escalate in severity and never contain an em dash', () => {
    const notices = [
      deadlineNotice({ ...base, stage: 'opened', daysLeft: 14 }),
      deadlineNotice({ ...base, stage: 'd7', daysLeft: 7 }),
      deadlineNotice({ ...base, stage: 'd2', daysLeft: 1 }),
      deadlineNotice({ ...base, stage: 'expired', daysLeft: -1 }),
    ]
    expect(notices.map((n) => n.severity)).toEqual(['blue', 'amber', 'red', 'red'])
    expect(notices.map((n) => n.title + n.subtitle).join('\n')).not.toContain('—')
    expect(notices[2].title).toContain('1 day')
    expect(notices[2].title).not.toContain('1 days')
  })
  it('dedupes per booking and stage', () => {
    expect(deadlineDedupeKey('b1', 'd7')).not.toBe(deadlineDedupeKey('b1', 'd2'))
    expect(deadlineDedupeKey('b1', 'd7')).toBe('evidence-deadline-b1-d7')
  })
})
