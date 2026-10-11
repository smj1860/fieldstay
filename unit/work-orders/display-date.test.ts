import { describe, it, expect } from 'vitest'
import { workOrderDisplayDate, workOrderDisplayDay } from '@/lib/work-orders/display-date'

describe('workOrderDisplayDate', () => {
  it('prefers a vendor-confirmed appointment over the PM deadline', () => {
    expect(workOrderDisplayDate({
      vendor_scheduled_at:     '2026-10-15T14:00:00Z',
      vendor_scheduled_window: 'afternoon',
      needed_by_date:          '2026-10-17',
    })).toEqual({ value: '2026-10-15T14:00:00Z', kind: 'appointment', window: 'afternoon' })
  })

  it('falls back to the deadline, and labels it as one', () => {
    // The kind is the point. Rendering a needed-by date under a "Scheduled"
    // label asserts a commitment nobody has made, which is the exact confusion
    // the date split exists to end.
    expect(workOrderDisplayDate({ vendor_scheduled_at: null, needed_by_date: '2026-10-17' }))
      .toEqual({ value: '2026-10-17', kind: 'deadline', window: null })
  })

  it('carries a null window on an appointment the vendor gave no window for', () => {
    expect(workOrderDisplayDate({ vendor_scheduled_at: '2026-10-15T14:00:00Z' }))
      .toEqual({ value: '2026-10-15T14:00:00Z', kind: 'appointment', window: null })
  })

  it('never reports a window on a deadline', () => {
    // A stale vendor_scheduled_window with no vendor_scheduled_at would
    // otherwise describe a window for a visit that is not booked.
    expect(workOrderDisplayDate({
      vendor_scheduled_at:     null,
      vendor_scheduled_window: 'morning',
      needed_by_date:          '2026-10-17',
    })).toEqual({ value: '2026-10-17', kind: 'deadline', window: null })
  })

  it('returns null when the work order carries no date at all', () => {
    expect(workOrderDisplayDate({ vendor_scheduled_at: null, needed_by_date: null })).toBeNull()
    expect(workOrderDisplayDate({})).toBeNull()
  })
})

describe('workOrderDisplayDay', () => {
  it('reduces a timestamp appointment to its date', () => {
    expect(workOrderDisplayDay({ vendor_scheduled_at: '2026-10-15T14:00:00Z' })).toBe('2026-10-15')
  })

  it('passes a date-only deadline through unchanged', () => {
    expect(workOrderDisplayDay({ needed_by_date: '2026-10-17' })).toBe('2026-10-17')
  })

  it('returns null rather than coercing an undated work order to today', () => {
    // Callers bucket null as "undated". Coercing would make every dateless work
    // order read as due now, i.e. overdue — which is how a `null <= today`
    // comparison behaved before this helper existed.
    expect(workOrderDisplayDay({})).toBeNull()
  })
})
