import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))

import { isSameDayFlip } from '@/lib/turnovers/generator'

// is_same_day_turnover gates the same_day_premium_pct markup on the owner
// ledger and the +1 crew recommendation. It was read but never written, so
// these cases pin the definition the generator now writes.
describe('isSameDayFlip', () => {
  it('is true when checkout and the next check-in share a date', () => {
    expect(isSameDayFlip({ checkout_date: '2026-11-14' }, { checkin_date: '2026-11-14' })).toBe(true)
  })

  it('is false when the next check-in is a later date', () => {
    expect(isSameDayFlip({ checkout_date: '2026-11-14' }, { checkin_date: '2026-11-15' })).toBe(false)
  })

  it('compares the date part only when a timestamp string slips through', () => {
    expect(isSameDayFlip({ checkout_date: '2026-11-14T00:00:00' }, { checkin_date: '2026-11-14' })).toBe(true)
  })

  it('is false when either date is empty rather than matching two blanks', () => {
    expect(isSameDayFlip({ checkout_date: '' }, { checkin_date: '' })).toBe(false)
  })
})
