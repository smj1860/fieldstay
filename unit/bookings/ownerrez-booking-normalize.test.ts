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
    guest: { name: 'Jane Doe', email: 'jane@example.com' },
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
    expect(result.guest_email).toBe('jane@example.com')
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
    expect(ownerRezBookingToNormalized(baseBooking({ status: 'hold' })).status).toBe('confirmed')
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
})
