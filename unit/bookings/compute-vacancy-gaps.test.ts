import { describe, it, expect } from 'vitest'
import { computeVacancyGaps, type ScheduleRow } from '@/app/(dashboard)/bookings/page'

function schedule(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 's1', property_id: 'prop_1', name: 'HVAC filter change',
    next_due_date: '2026-08-01', estimated_cost: 50, assigned_vendor_id: null,
    active_from_month: null, active_to_month: null,
    ...overrides,
  }
}

describe('computeVacancyGaps', () => {
  it('flags a gap >= 14 days with an eligible schedule inside the window', () => {
    const bookings = [
      { property_id: 'prop_1', checkin_date: '2026-07-01', checkout_date: '2026-07-10', status: 'confirmed' },
      { property_id: 'prop_1', checkin_date: '2026-08-05', checkout_date: '2026-08-15', status: 'confirmed' },
    ]
    const schedules = new Map([['prop_1', [schedule({ next_due_date: '2026-08-01' })]]])

    const gaps = computeVacancyGaps(bookings, [{ id: 'prop_1' }], schedules)

    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ property_id: 'prop_1', gap_start: '2026-07-10', gap_end: '2026-08-05' })
    expect(gaps[0]!.candidates).toHaveLength(1)
  })

  it('ignores a gap shorter than the 14-day threshold', () => {
    const bookings = [
      { property_id: 'prop_1', checkin_date: '2026-07-01', checkout_date: '2026-07-10', status: 'confirmed' },
      { property_id: 'prop_1', checkin_date: '2026-07-15', checkout_date: '2026-07-20', status: 'confirmed' },
    ]
    const schedules = new Map([['prop_1', [schedule()]]])

    expect(computeVacancyGaps(bookings, [{ id: 'prop_1' }], schedules)).toEqual([])
  })

  it('excludes cancelled bookings from gap detection', () => {
    const bookings = [
      { property_id: 'prop_1', checkin_date: '2026-07-01', checkout_date: '2026-07-10', status: 'confirmed' },
      { property_id: 'prop_1', checkin_date: '2026-07-20', checkout_date: '2026-07-25', status: 'cancelled' },
      { property_id: 'prop_1', checkin_date: '2026-08-05', checkout_date: '2026-08-15', status: 'confirmed' },
    ]
    const schedules = new Map([['prop_1', [schedule()]]])

    const gaps = computeVacancyGaps(bookings, [{ id: 'prop_1' }], schedules)

    // Should treat 07-10 -> 08-05 as one gap (cancelled booking removed from the sequence).
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ gap_start: '2026-07-10', gap_end: '2026-08-05' })
  })

  it('excludes a schedule due after the gap window (capped at 90 days)', () => {
    const bookings = [
      { property_id: 'prop_1', checkin_date: '2026-07-01', checkout_date: '2026-07-10', status: 'confirmed' },
      { property_id: 'prop_1', checkin_date: '2026-11-15', checkout_date: '2026-11-20', status: 'confirmed' },
    ]
    // next_due_date is ~4 months after checkout — past the 90-day lookahead cap.
    const schedules = new Map([['prop_1', [schedule({ next_due_date: '2026-11-01' })]]])

    expect(computeVacancyGaps(bookings, [{ id: 'prop_1' }], schedules)).toEqual([])
  })

  it("never surfaces another property's maintenance schedules", () => {
    const bookings = [
      { property_id: 'prop_1', checkin_date: '2026-07-01', checkout_date: '2026-07-10', status: 'confirmed' },
      { property_id: 'prop_1', checkin_date: '2026-08-05', checkout_date: '2026-08-15', status: 'confirmed' },
    ]
    // Only prop_2 has a schedule queued — prop_1's gap should surface zero candidates.
    const schedules = new Map([['prop_2', [schedule({ property_id: 'prop_2' })]]])

    expect(computeVacancyGaps(bookings, [{ id: 'prop_1' }], schedules)).toEqual([])
  })
})
