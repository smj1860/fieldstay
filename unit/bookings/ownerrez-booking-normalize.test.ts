import { describe, it, expect } from 'vitest'
import { ownerRezBookingToNormalized } from '@/lib/integrations/providers/ownerrez'
import type { OwnerRezBooking } from '@/lib/integrations/types'

function baseBooking(overrides: Partial<OwnerRezBooking> = {}): OwnerRezBooking {
  return {
    id:           42,
    arrival:      '2026-08-03',
    departure:    '2026-08-10',
    status:       'Confirmed',
    is_block:     false,
    property_id:  7,
    channel_name: 'Airbnb (API)',
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

  it('maps channel_name to the FieldStay booking source', () => {
    expect(ownerRezBookingToNormalized(baseBooking({ channel_name: 'VRBO' })).source).toBe('vrbo')
    expect(ownerRezBookingToNormalized(baseBooking({ channel_name: 'HomeAway' })).source).toBe('vrbo')
    expect(ownerRezBookingToNormalized(baseBooking({ channel_name: 'Booking.com' })).source).toBe('booking_com')
    expect(ownerRezBookingToNormalized(baseBooking({ channel_name: 'Direct' })).source).toBe('direct')
    expect(ownerRezBookingToNormalized(baseBooking({ channel_name: undefined })).source).toBe('other')
  })

  it('always returns null checkin_time/checkout_time (OwnerRez has no time-of-day field)', () => {
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
