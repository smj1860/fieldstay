import { describe, it, expect } from 'vitest'
import { buildOwnerRezBookingRow, ownerRezBookingToNormalized, summarizeOwnerRezCleaningDates } from '@/lib/integrations/providers/ownerrez'
import type { OwnerRezBooking } from '@/lib/integrations/types'

function baseBooking(overrides: Partial<OwnerRezBooking> = {}): OwnerRezBooking {
  return {
    id:           42,
    arrival:      '2026-08-03',
    departure:    '2026-08-10',
    status:       'Confirmed',
    is_block:     false,
    property_id:  7,
    listing_site: 'Airbnb (API)',
    guest: { id: 99, first_name: 'Jane', last_name: 'Doe' },
    ...overrides,
  }
}

describe('ownerRezBookingToNormalized', () => {
  it('maps every field on the happy path', () => {
    const result = ownerRezBookingToNormalized(baseBooking())

    expect(result.external_id).toBe('42')
    expect(result.property_external_id).toBe('7')
    expect(result.checkin_date).toBe('2026-08-03')
    expect(result.checkout_date).toBe('2026-08-10')
    expect(result.checkin_time).toBeNull()
    expect(result.checkout_time).toBeNull()
    expect(result.status).toBe('confirmed')
    expect(result.guest_name).toBe('Jane Doe')
    expect(result.guest_email).toBeNull()
    expect(result.source).toBe('airbnb')
    expect(result.is_block).toBe(false)
  })

  it('returns null property_external_id when property_id is undefined', () => {
    const result = ownerRezBookingToNormalized(baseBooking({ property_id: undefined }))
    expect(result.property_external_id).toBeNull()
  })

  it('preserves property_id 0 as a real external id, not null', () => {
    const result = ownerRezBookingToNormalized(baseBooking({ property_id: 0 }))
    expect(result.property_external_id).toBe('0')
  })

  it('returns null guest_name/guest_email when guest is absent', () => {
    const result = ownerRezBookingToNormalized(baseBooking({ guest: undefined }))
    expect(result.guest_name).toBeNull()
    expect(result.guest_email).toBeNull()
  })

  it('defaults is_block to false when absent', () => {
    const result = ownerRezBookingToNormalized(baseBooking({ is_block: undefined }))
    expect(result.is_block).toBe(false)
  })

  it('maps booking statuses to the confirmed/tentative/cancelled trio', () => {
    expect(ownerRezBookingToNormalized(baseBooking({ status: 'Tentative' })).status).toBe('tentative')
    expect(ownerRezBookingToNormalized(baseBooking({ status: 'Cancelled' })).status).toBe('cancelled')
    expect(ownerRezBookingToNormalized(baseBooking({ status: 'Canceled' })).status).toBe('cancelled')
    // Unrecognized statuses fail toward caution ('tentative'), not 'confirmed'.
    expect(ownerRezBookingToNormalized(baseBooking({ status: 'hold' })).status).toBe('tentative')
  })

  it('maps listing_site to the FieldStay booking source', () => {
    expect(ownerRezBookingToNormalized(baseBooking({ listing_site: 'VRBO' })).source).toBe('vrbo')
    expect(ownerRezBookingToNormalized(baseBooking({ listing_site: 'HomeAway' })).source).toBe('vrbo')
    expect(ownerRezBookingToNormalized(baseBooking({ listing_site: 'Booking.com' })).source).toBe('booking_com')
    expect(ownerRezBookingToNormalized(baseBooking({ listing_site: 'Direct' })).source).toBe('direct')
    expect(ownerRezBookingToNormalized(baseBooking({ listing_site: undefined })).source).toBe('other')
  })

  it('carries OwnerRez check_in/check_out through as the times of day', () => {
    // This test used to assert the opposite — "OwnerRez has no time-of-day
    // field" — and passed, because the mapper hardcoded both to null. Both
    // were wrong: the booking schema documents check_in and check_out as
    // 24-hour "HH:mm" strings in the property's timezone.
    //
    // It mattered. lib/turnovers/generator.ts falls back to '11:00'/'15:00'
    // when a booking has no time and the property has no default, so every
    // OwnerRez cleaning window was computed from an assumption. Production had
    // 0 of 30 OwnerRez bookings with times against Hospitable's 11 of 12.
    const result = ownerRezBookingToNormalized(baseBooking({ check_in: '16:00', check_out: '09:00' }))
    expect(result.checkin_time).toBe('16:00')
    expect(result.checkout_time).toBe('09:00')
  })

  it('normalizes a missing time to null so the row builder can omit the column', () => {
    // null here is not "write null" — buildOwnerRezBookingRow reads it as the
    // signal to leave the key OUT of the upsert, so a PM's manual edit
    // survives. Writing null on every sync is what would clobber it.
    const result = ownerRezBookingToNormalized(baseBooking())
    expect(result.checkin_time).toBeNull()
    expect(result.checkout_time).toBeNull()
  })

  it('maps type: owner to stay_type: owner_stay', () => {
    const result = ownerRezBookingToNormalized(baseBooking({ type: 'owner' }))
    expect(result.stay_type).toBe('owner_stay')
    expect(result.is_block).toBe(false)
  })

  it('defaults stay_type to guest_stay when type is absent or a plain booking', () => {
    expect(ownerRezBookingToNormalized(baseBooking({ type: undefined })).stay_type).toBe('guest_stay')
    expect(ownerRezBookingToNormalized(baseBooking({ type: 'booking' })).stay_type).toBe('guest_stay')
  })

  it.each(['block', 'quote_hold', 'linked_availability'] as const)(
    'treats type: %s as a block regardless of the raw is_block/status fields',
    (blockType) => {
      const result = ownerRezBookingToNormalized(
        baseBooking({ type: blockType, is_block: false, status: 'Confirmed' })
      )
      expect(result.is_block).toBe(true)
      expect(result.status).toBe('blocked')
    }
  )

  it('still honors a raw is_block: true even when type is a plain booking, and status agrees', () => {
    const result = ownerRezBookingToNormalized(baseBooking({ type: 'booking', is_block: true }))
    // is_block and status must never disagree — a plain 'booking' type with
    // is_block: true (unexpected, but not impossible) maps status to
    // 'blocked' too, not 'confirmed', so turnover generation (which reads
    // is_block) and the bookings UI (which reads status) show the same thing.
    expect(result.is_block).toBe(true)
    expect(result.status).toBe('blocked')
  })
})

describe('buildOwnerRezBookingRow — time columns are omitted, never nulled', () => {
  const MAP = { '7': 'fs-prop-uuid' }

  it('includes the time columns when OwnerRez sent them', () => {
    const row = buildOwnerRezBookingRow('org-1', baseBooking({ check_in: '16:00', check_out: '09:00' }), MAP)
    expect(row.checkin_time).toBe('16:00')
    expect(row.checkout_time).toBe('09:00')
  })

  it('OMITS the keys entirely when OwnerRez sent nothing — not null', () => {
    // THE distinction, and the reason the row builder spreads these in rather
    // than assigning them. This upsert runs on every sync. A literal
    // `checkin_time: null` would overwrite a PM's manual edit each time, and
    // it would do it silently because the write succeeds — the same
    // `?? null`-in-an-upload-payload defect the crew Dexie guardrail exists
    // for, one provider over.
    //
    // `in` rather than a truthiness or undefined check: the failure being
    // guarded is a key that is PRESENT carrying null, which `=== undefined`
    // would not distinguish from an absent key.
    const row = buildOwnerRezBookingRow('org-1', baseBooking(), MAP)
    expect('checkin_time'  in row).toBe(false)
    expect('checkout_time' in row).toBe(false)
  })

  it('omits only the half that is missing', () => {
    const row = buildOwnerRezBookingRow('org-1', baseBooking({ check_out: '10:00' }), MAP)
    expect('checkin_time' in row).toBe(false)
    expect(row.checkout_time).toBe('10:00')
  })
})

describe('summarizeOwnerRezCleaningDates — the probe, not a feature', () => {
  // cleaning_date is read for MEASUREMENT only. A FieldStay turnover is a
  // window (checkout_datetime -> checkin_datetime), not an appointment, so
  // adopting a scheduled point is a model change. This decides whether that
  // change is worth making, against production data rather than a guess.

  it('counts nothing when the field is absent, which is the expected steady state', () => {
    const p = summarizeOwnerRezCleaningDates([baseBooking(), baseBooking()])
    expect(p).toEqual({ total: 2, withCleaningDate: 0, derivedFromCheckout: 0, withTimeOfDay: 0 })
  })

  it('flags a cleaning date that is just the departure date as DERIVED', () => {
    // The finding that would kill the idea outright: if OwnerRez stamps the
    // checkout date, the field carries nothing the generator does not already
    // compute from checkout_date.
    const p = summarizeOwnerRezCleaningDates([
      baseBooking({ departure: '2026-08-10', cleaning_date: '2026-08-10T00:00:00' }),
    ])
    expect(p.withCleaningDate).toBe(1)
    expect(p.derivedFromCheckout).toBe(1)
    expect(p.withTimeOfDay).toBe(0)
  })

  it('separates a real scheduled time from a bare date on the same day', () => {
    // Same date as departure, but an actual hour — still "derived" by date,
    // yet the time IS new information. Both counters fire, deliberately.
    const p = summarizeOwnerRezCleaningDates([
      baseBooking({ departure: '2026-08-10', cleaning_date: '2026-08-10T14:30:00' }),
    ])
    expect(p.derivedFromCheckout).toBe(1)
    expect(p.withTimeOfDay).toBe(1)
  })

  it('flags a date that is NOT the departure — the case worth building for', () => {
    // Checkout Monday, clean scheduled Wednesday. Our window spans the whole
    // gap and gives the crew no guidance about which day; this is the PM's
    // stated intent and the only shape that justifies a schema change.
    const p = summarizeOwnerRezCleaningDates([
      baseBooking({ departure: '2026-08-10', cleaning_date: '2026-08-12T09:00:00' }),
    ])
    expect(p.withCleaningDate).toBe(1)
    expect(p.derivedFromCheckout).toBe(0)
    expect(p.withTimeOfDay).toBe(1)
  })

  it('compares DATE STRINGS, never parsed Dates', () => {
    // The value is documented as being in the property's timezone with no
    // offset. new Date('2026-08-10T23:00:00') reinterprets that as UTC, and in
    // any negative-offset zone the date shifts a day — corrupting the exact
    // comparison this probe exists to make. A late-evening clean on the
    // departure date must still read as derived.
    const p = summarizeOwnerRezCleaningDates([
      baseBooking({ departure: '2026-08-10', cleaning_date: '2026-08-10T23:00:00' }),
    ])
    expect(p.derivedFromCheckout).toBe(1)
  })

  it('tolerates a departure carrying a time component', () => {
    const p = summarizeOwnerRezCleaningDates([
      baseBooking({ departure: '2026-08-10T00:00:00', cleaning_date: '2026-08-10T11:00:00' }),
    ])
    expect(p.derivedFromCheckout).toBe(1)
  })

  it('ignores empty strings rather than counting them as present', () => {
    const p = summarizeOwnerRezCleaningDates([baseBooking({ cleaning_date: '' })])
    expect(p.withCleaningDate).toBe(0)
    expect(p.total).toBe(1)
  })
})
