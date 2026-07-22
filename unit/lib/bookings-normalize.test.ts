import { describe, it, expect, vi, afterEach } from 'vitest'
import type { NormalizedBooking } from '@/lib/bookings/normalize'
import { unmappedBookingStatus } from '@/lib/bookings/normalize'

// booking_source enum per CLAUDE.md: airbnb | vrbo | booking_com | direct |
// manual | other. unmappedBookingStatus doesn't branch on provider/source —
// it always defaults to 'tentative' regardless — but we still exercise it
// once per source value since that's the shape every real call site passes.
const SOURCES = ['airbnb', 'vrbo', 'booking_com', 'direct', 'manual', 'other'] as const

describe('unmappedBookingStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(SOURCES)('defaults to "tentative" for provider %s with an unrecognized raw status', (source) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(unmappedBookingStatus(source, 'some_weird_status')).toBe('tentative')
  })

  it('never defaults to "confirmed" — an unrecognized status must fail toward caution', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result: 'tentative' = unmappedBookingStatus('hospitable', 'unknown')

    expect(result).not.toBe('confirmed')
    expect(result).toBe('tentative')
  })

  it('logs a warning naming both the provider and the unrecognized raw status', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    unmappedBookingStatus('ownerrez', 'weird_status_xyz')

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ownerrez'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('weird_status_xyz'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tentative'))
  })

  it('does not throw for an empty raw status string', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(unmappedBookingStatus('direct', '')).toBe('tentative')
  })
})

describe('NormalizedBooking shape', () => {
  it('accepts a fully-populated booking object for every booking_source', () => {
    for (const source of SOURCES) {
      const booking: NormalizedBooking = {
        external_id:           'ext-123',
        property_external_id:  'prop-ext-456',
        checkin_date:          '2026-08-01',
        checkout_date:         '2026-08-05',
        checkin_time:          '16:00',
        checkout_time:         '10:00',
        status:                'confirmed',
        guest_name:            'Test Guest',
        guest_email:           'guest@example.com',
        source,
        is_block:              false,
        stay_type:             'guest_stay',
        actual_total_amount:   450.5,
      }

      expect(booking.source).toBe(source)
    }
  })

  it('accepts an owner-block booking with nullable fields unset', () => {
    const block: NormalizedBooking = {
      external_id:           'ext-block-1',
      property_external_id:  null,
      checkin_date:          null,
      checkout_date:         null,
      checkin_time:          null,
      checkout_time:         null,
      status:                'blocked',
      guest_name:            null,
      guest_email:           null,
      source:                'manual',
      is_block:              true,
      stay_type:             'owner_stay',
      actual_total_amount:   null,
    }

    expect(block.is_block).toBe(true)
    expect(block.stay_type).toBe('owner_stay')
  })
})
