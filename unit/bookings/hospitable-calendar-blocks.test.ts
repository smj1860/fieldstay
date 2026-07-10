import { describe, it, expect } from 'vitest'
import {
  consolidateHospitableBlocks,
  type HospitableCalendarDay,
} from '@/lib/integrations/providers/hospitable'

function day(overrides: Partial<HospitableCalendarDay> = {}): HospitableCalendarDay {
  return {
    date:                '2026-07-10',
    day:                 'FRIDAY',
    min_stay:            1,
    note:                null,
    closed_for_checkin:  false,
    closed_for_checkout: false,
    status: {
      reason:      'AVAILABLE',
      source:      'airbnb',
      source_type: 'PLATFORM',
      available:   true,
    },
    price: { amount: 7500, currency: 'USD', formatted: '$75.00' },
    ...overrides,
  }
}

function reserved(date: string): HospitableCalendarDay {
  return day({
    date,
    status: { reason: 'RESERVED', source: null, source_type: 'RESERVATION', available: false },
  })
}

function blocked(date: string): HospitableCalendarDay {
  return day({
    date,
    closed_for_checkin:  true,
    closed_for_checkout: true,
    status: { reason: 'BLOCKED', source: null, source_type: 'USER', available: false },
  })
}

describe('consolidateHospitableBlocks', () => {
  it('returns no ranges when every day is available', () => {
    const days = [day({ date: '2026-07-10' }), day({ date: '2026-07-11' })]
    expect(consolidateHospitableBlocks(days)).toEqual([])
  })

  it('ignores a real reservation (source_type RESERVATION) even though it is unavailable', () => {
    const days = [reserved('2026-07-15'), reserved('2026-07-16')]
    expect(consolidateHospitableBlocks(days)).toEqual([])
  })

  it('merges consecutive manually-blocked days into a single range', () => {
    const days = [
      day({ date: '2026-07-22' }),
      blocked('2026-07-23'),
      blocked('2026-07-24'),
      blocked('2026-07-25'),
      day({ date: '2026-07-26' }),
    ]
    expect(consolidateHospitableBlocks(days)).toEqual([
      { checkin_date: '2026-07-23', checkout_date: '2026-07-26' },
    ])
  })

  it('produces separate ranges for two non-adjacent blocks', () => {
    const days = [
      blocked('2026-07-01'),
      day({ date: '2026-07-02' }),
      blocked('2026-07-10'),
      blocked('2026-07-11'),
    ]
    expect(consolidateHospitableBlocks(days)).toEqual([
      { checkin_date: '2026-07-01', checkout_date: '2026-07-02' },
      { checkin_date: '2026-07-10', checkout_date: '2026-07-12' },
    ])
  })

  it('closes a trailing block range that runs to the end of the fetched window', () => {
    const days = [day({ date: '2026-07-01' }), blocked('2026-07-02'), blocked('2026-07-03')]
    expect(consolidateHospitableBlocks(days)).toEqual([
      { checkin_date: '2026-07-02', checkout_date: '2026-07-04' },
    ])
  })

  it('does not treat a real reservation adjacent to a block as part of the same range', () => {
    const days = [reserved('2026-07-15'), blocked('2026-07-16'), blocked('2026-07-17')]
    expect(consolidateHospitableBlocks(days)).toEqual([
      { checkin_date: '2026-07-16', checkout_date: '2026-07-18' },
    ])
  })
})
