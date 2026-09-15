import { describe, it, expect } from 'vitest'
import { formatTime12h } from '@/lib/utils/time-of-day'

// ============================================================================
// Postgres's `time` type accepts the literal '24:00:00' as a valid end-of-day
// value — plausible from a time picker that allows it, or forwarded verbatim
// from a PMS import. Without the hour===24 normalization, `24 >= 12` reads as
// PM, producing "12:00 PM" (noon) instead of midnight — a checkout time shown
// 12 hours wrong directly to a guest in the guidebook and in SMS nudges.
// ============================================================================

describe('formatTime12h', () => {
  it('formats ordinary times', () => {
    expect(formatTime12h('16:00:00')).toBe('4:00 PM')
    expect(formatTime12h('09:30:00')).toBe('9:30 AM')
    expect(formatTime12h('00:00:00')).toBe('12:00 AM')
    expect(formatTime12h('12:00:00')).toBe('12:00 PM')
  })

  it('renders the 24:00:00 end-of-day boundary as midnight, not noon', () => {
    expect(formatTime12h('24:00:00')).toBe('12:00 AM')
  })

  it('still respects the minute component at the boundary', () => {
    // 24:00 is always exactly midnight in practice, but the function should
    // not special-case the minute away.
    expect(formatTime12h('24:00')).toBe('12:00 AM')
  })

  it('returns null for null/undefined/empty input', () => {
    expect(formatTime12h(null)).toBeNull()
    expect(formatTime12h(undefined)).toBeNull()
    expect(formatTime12h('')).toBeNull()
  })

  it('returns null for unparseable input', () => {
    expect(formatTime12h('not-a-time')).toBeNull()
  })
})
