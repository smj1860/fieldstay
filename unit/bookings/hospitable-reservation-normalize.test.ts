import { describe, it, expect } from 'vitest'
import {
  hospitableReservationToNormalized,
  type HospitableReservation,
} from '@/lib/integrations/providers/hospitable'

function baseReservation(overrides: Partial<HospitableReservation> = {}): HospitableReservation {
  return {
    id:             'resv-1',
    platform:       'airbnb',
    platform_id:    'HMABC123',
    arrival_date:   '2026-08-03T00:00:00-05:00',
    departure_date: '2026-08-10T00:00:00-05:00',
    check_in:       '2026-08-03T16:00:00-05:00',
    check_out:      '2026-08-10T10:00:00-05:00',
    reservation_status: { current: { category: 'accepted', sub_category: 'confirmed' } },
    guests: { total: 4, adult_count: 2, child_count: 2, infant_count: 0, pet_count: 0 },
    guest: {
      first_name:    'Jane',
      last_name:     'Doe',
      email:         'jane@example.com',
      phone_numbers: ['+15551234567'],
    },
    properties: [{ id: 'hosp-prop-1', name: 'Bear Hollow Cabin', public_name: 'Bear Hollow Cabin #2' }],
    ...overrides,
  }
}

describe('hospitableReservationToNormalized', () => {
  it('maps every field on the happy path', () => {
    const result = hospitableReservationToNormalized(baseReservation())

    expect(result.external_id).toBe('resv-1')
    expect(result.property_external_id).toBe('hosp-prop-1')
    expect(result.checkin_date).toBe('2026-08-03')
    expect(result.checkout_date).toBe('2026-08-10')
    expect(result.checkin_time).toBe('16:00')
    expect(result.checkout_time).toBe('10:00')
    expect(result.status).toBe('confirmed')
    expect(result.guest_name).toBe('Jane Doe')
    expect(result.guest_email).toBe('jane@example.com')
    expect(result.source).toBe('airbnb')
    expect(result.is_block).toBe(false)
  })

  it('maps reservation_status categories to the confirmed/tentative/cancelled trio', () => {
    expect(hospitableReservationToNormalized(baseReservation({
      reservation_status: { current: { category: 'request', sub_category: 'x' } },
    })).status).toBe('tentative')

    expect(hospitableReservationToNormalized(baseReservation({
      reservation_status: { current: { category: 'cancelled', sub_category: 'x' } },
    })).status).toBe('cancelled')

    expect(hospitableReservationToNormalized(baseReservation({
      reservation_status: { current: { category: 'not accepted', sub_category: 'x' } },
    })).status).toBe('cancelled')

    expect(hospitableReservationToNormalized(baseReservation({
      reservation_status: { current: { category: 'unknown', sub_category: 'x' } },
    })).status).toBe('confirmed')
  })

  it('maps platform to the FieldStay booking source', () => {
    expect(hospitableReservationToNormalized(baseReservation({ platform: 'Airbnb' })).source).toBe('airbnb')
    expect(hospitableReservationToNormalized(baseReservation({ platform: 'homeaway' })).source).toBe('vrbo')
    expect(hospitableReservationToNormalized(baseReservation({ platform: 'booking' })).source).toBe('booking_com')
    expect(hospitableReservationToNormalized(baseReservation({ platform: 'manual' })).source).toBe('direct')
    expect(hospitableReservationToNormalized(baseReservation({ platform: 'agoda' })).source).toBe('other')
  })

  it('returns null property_external_id when properties is absent', () => {
    const result = hospitableReservationToNormalized(baseReservation({ properties: undefined }))
    expect(result.property_external_id).toBeNull()
  })

  it('returns null property_external_id when properties is an empty array', () => {
    const result = hospitableReservationToNormalized(baseReservation({ properties: [] }))
    expect(result.property_external_id).toBeNull()
  })

  it('returns null guest_name and guest_email when guest is absent (guests-count-only payload)', () => {
    const result = hospitableReservationToNormalized(baseReservation({ guest: null }))
    expect(result.guest_name).toBeNull()
    expect(result.guest_email).toBeNull()
  })

  it('falls back to last_name only, or first_name only, when the other is missing', () => {
    const lastOnly = hospitableReservationToNormalized(baseReservation({
      guest: { first_name: null, last_name: 'Doe', email: null, phone_numbers: null },
    }))
    expect(lastOnly.guest_name).toBe('Doe')

    const firstOnly = hospitableReservationToNormalized(baseReservation({
      guest: { first_name: 'Jane', last_name: null, email: null, phone_numbers: null },
    }))
    expect(firstOnly.guest_name).toBe('Jane')
  })

  it('returns null guest_name when guest is present but both names are missing', () => {
    const result = hospitableReservationToNormalized(baseReservation({
      guest: { first_name: null, last_name: null, email: 'x@example.com', phone_numbers: null },
    }))
    expect(result.guest_name).toBeNull()
    expect(result.guest_email).toBe('x@example.com')
  })

  it('defaults checkin/checkout time when check_in/check_out are missing', () => {
    const result = hospitableReservationToNormalized(baseReservation({
      check_in:  undefined as unknown as string,
      check_out: undefined as unknown as string,
    }))
    expect(result.checkin_time).toBe('15:00')
    expect(result.checkout_time).toBe('11:00')
  })

  it('returns null checkin/checkout date when arrival_date/departure_date are missing', () => {
    const result = hospitableReservationToNormalized(baseReservation({
      arrival_date:   undefined as unknown as string,
      departure_date: undefined as unknown as string,
    }))
    expect(result.checkin_date).toBeNull()
    expect(result.checkout_date).toBeNull()
  })

  it('always returns is_block: false (Hospitable has no owner-block concept)', () => {
    expect(hospitableReservationToNormalized(baseReservation()).is_block).toBe(false)
  })
})
