import { describe, it, expect } from 'vitest'
import {
  trialWarningAt, trialExpiredEmailAt, extendedTrialEnd, roundSuffix, MAX_TRIAL_EXTENSIONS,
} from '@/lib/billing/trial-schedule'
import { TRIAL_WARNING_DAYS } from '@/lib/billing/trial'

const END = new Date('2026-11-24T20:01:22.543Z')

describe('trial email timing', () => {
  it('warns TRIAL_WARNING_DAYS before the end and says "ended" two hours after it', () => {
    expect(END.getTime() - trialWarningAt(END).getTime()).toBe(TRIAL_WARNING_DAYS * 86_400_000)
    expect(trialExpiredEmailAt(END).getTime() - END.getTime()).toBe(2 * 3_600_000)
  })
})

describe('extendedTrialEnd', () => {
  it('returns the live date when it is later', () => {
    expect(extendedTrialEnd(END, '2026-12-01T20:01:22.543Z')?.toISOString()).toBe('2026-12-01T20:01:22.543Z')
  })

  it.each([
    ['the same date', END.toISOString()],
    ['a re-saved timestamp a few seconds later', new Date(END.getTime() + 30_000).toISOString()],
    ['an EARLIER date (a shortened trial is not an extension)', '2026-11-20T00:00:00.000Z'],
    ['nothing stored', null],
    ['nothing at all', undefined],
    ['an empty string', ''],
    ['an unparseable value', 'not a date'],
  ])('returns null for %s', (_label, live) => {
    expect(extendedTrialEnd(END, live)).toBeNull()
  })

  it('counts a difference past the tolerance as an extension', () => {
    expect(extendedTrialEnd(END, new Date(END.getTime() + 61_000).toISOString())).not.toBeNull()
  })
})

describe('roundSuffix', () => {
  it('leaves round 0 untouched so sequences already in flight keep their ids and idempotency keys', () => {
    expect(roundSuffix(0)).toBe('')
    expect(roundSuffix(1)).toBe('-r1')
    expect(roundSuffix(3)).toBe('-r3')
  })

  it('caps re-planning at a finite number', () => {
    expect(MAX_TRIAL_EXTENSIONS).toBeGreaterThan(0)
    expect(MAX_TRIAL_EXTENSIONS).toBeLessThan(50)
  })
})
