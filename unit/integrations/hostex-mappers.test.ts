import { describe, it, expect, vi } from 'vitest'

// ============================================================================
// Hostex raw → normalized mapping.
//
// Every field here is confirmed against api-doc.hostex.io's published schemas
// for /properties and /reservations, and the tests below pin the places where
// Hostex differs from the providers this codebase already had — which is where
// a copy-paste from the Hospitable mapper would have gone quietly wrong:
//
//   - reservations have NO `id`; reservation_code is the identity
//   - amounts are MAJOR UNITS, not the integer cents Hospitable sends
//   - latitude/longitude are STRINGS
//   - there is one free-form address string, not structured city/state/zip
//   - /properties exposes no bedrooms/bathrooms/occupancy/amenities at all
// ============================================================================

import {
  hostexPropertyToNormalized,
  hostexReservationToNormalized,
  parseHostexAddress,
  mapHostexStatus,
  mapHostexChannel,
  extractHostexActualTotal,
} from '@/lib/integrations/providers/hostex.mappers'
import type { HostexProperty, HostexReservation } from '@/lib/integrations/providers/hostex.types'

function reservation(overrides: Partial<HostexReservation> = {}): HostexReservation {
  return {
    reservation_code: 'HX-001',
    property_id:      4242,
    check_in_date:    '2026-09-01',
    check_out_date:   '2026-09-05',
    status:           'accepted',
    ...overrides,
  }
}

describe('parseHostexAddress', () => {
  it('splits a US-style address into street/city/state/zip', () => {
    expect(parseHostexAddress('123 Lake Rd, Alexander City, AL 35010')).toEqual({
      address: '123 Lake Rd', city: 'Alexander City', state: 'AL', zip: '35010',
    })
  })

  it('tolerates a trailing country segment and a ZIP+4', () => {
    expect(parseHostexAddress('9 Pine St, Dadeville, AL 36853-1234, United States')).toEqual({
      address: '9 Pine St', city: 'Dadeville', state: 'AL', zip: '36853',
    })
  })

  it('returns nulls rather than a guess when the shape does not match', () => {
    // A mis-parsed state feeds timezone resolution and a mis-parsed ZIP feeds
    // geocoding — both are worse wrong than absent.
    expect(parseHostexAddress('Villa Bellavista, Lake Como')).toEqual({
      address: 'Villa Bellavista, Lake Como', city: null, state: null, zip: null,
    })
  })

  it('handles an absent address', () => {
    expect(parseHostexAddress(null)).toEqual({ address: null, city: null, state: null, zip: null })
  })

  it('keeps a multi-comma street intact', () => {
    expect(parseHostexAddress('Unit 4, 123 Lake Rd, Alexander City, AL 35010')).toEqual({
      address: 'Unit 4, 123 Lake Rd', city: 'Alexander City', state: 'AL', zip: '35010',
    })
  })

  it('stays linear on a pathological comma-heavy input (ReDoS guard)', () => {
    // The natural regex for this shape starts `^(.*),\s*...`, and that greedy
    // prefix backtracks super-linearly against a later comma alternation —
    // SonarQube S8786. The input is PROVIDER-supplied text reaching an Inngest
    // step, so a hang here is reachable, not theoretical. A time bound is the
    // only assertion that can tell the two implementations apart: both return
    // the same value, one of them just takes exponentially longer.
    const evil = `${'a,'.repeat(2_000)}b`

    const started = Date.now()
    const result  = parseHostexAddress(evil)
    const elapsed = Date.now() - started

    expect(result.state).toBeNull()
    expect(elapsed).toBeLessThan(1_000)
  })
})

describe('hostexPropertyToNormalized', () => {
  const prop: HostexProperty = {
    id:        4242,
    title:     'Lake House',
    address:   '123 Lake Rd, Alexander City, AL 35010',
    latitude:  '32.9440',
    longitude: '-85.9540',
  }

  it('keys external_id on the numeric id as a string and parses coordinates', () => {
    const n = hostexPropertyToNormalized(prop)
    expect(n.external_id).toBe('4242')
    expect(n.name).toBe('Lake House')
    // Strings in Hostex's schema — a raw pass-through would write text into a
    // numeric column, or silently NaN.
    expect(n.lat).toBe(32.944)
    expect(n.lng).toBe(-85.954)
    expect(n.zip).toBe('35010')
    expect(n.timezone).toBe('America/Chicago')
  })

  it('drops non-numeric coordinates instead of writing NaN', () => {
    const n = hostexPropertyToNormalized({ ...prop, latitude: '', longitude: 'n/a' })
    expect(n.lat).toBeNull()
    expect(n.lng).toBeNull()
  })

  it('leaves PM-editable content fields null — Hostex has no source for them', () => {
    // These are overwritten on every sync by upsert-normalized, so anything
    // fabricated here would clobber the PM's own entry on every run.
    const n = hostexPropertyToNormalized(prop)
    expect(n.wifi_name).toBeNull()
    expect(n.wifi_password).toBeNull()
    expect(n.access_instructions).toBeNull()
    expect(n.house_manual).toBeNull()
    expect(n.amenities).toBeNull()
  })

  it('falls back to a stable name when title is empty', () => {
    expect(hostexPropertyToNormalized({ id: 7, title: '' }).name).toBe('Hostex property 7')
  })
})

describe('mapHostexStatus', () => {
  it('treats only accepted as confirmed', () => {
    expect(mapHostexStatus('accepted')).toBe('confirmed')
  })

  it('maps in-flight states to tentative', () => {
    expect(mapHostexStatus('wait_accept')).toBe('tentative')
    expect(mapHostexStatus('wait_pay')).toBe('tentative')
  })

  it('maps cancelled, denied and timeout to cancelled', () => {
    expect(mapHostexStatus('cancelled')).toBe('cancelled')
    expect(mapHostexStatus('denied')).toBe('cancelled')
    expect(mapHostexStatus('timeout')).toBe('cancelled')
  })

  it('falls back to tentative — never confirmed — for an unknown status', () => {
    // 'confirmed' is what schedules a real turnover and dispatches crew.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(mapHostexStatus('some_new_state' as never)).toBe('tentative')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('mapHostexChannel', () => {
  it('maps the channels the booking_source enum has members for', () => {
    expect(mapHostexChannel('airbnb')).toBe('airbnb')
    expect(mapHostexChannel('vrbo')).toBe('vrbo')
    expect(mapHostexChannel('booking.com')).toBe('booking_com')
    expect(mapHostexChannel('direct')).toBe('direct')
  })

  it("lands Hostex's wider channel list on 'other' rather than mislabelling it", () => {
    expect(mapHostexChannel('agoda')).toBe('other')
    expect(mapHostexChannel('expedia')).toBe('other')
    expect(mapHostexChannel('trip.com')).toBe('other')
    expect(mapHostexChannel(undefined)).toBe('other')
  })
})

describe('extractHostexActualTotal', () => {
  it('nets the channel commission off the gross rate', () => {
    // The owner-facing figure, matching hospitable's preference for
    // host.revenue over guest.total_price.
    const amount = extractHostexActualTotal(reservation({
      rates: {
        total_rate:       { currency: 'USD', amount: 1000 },
        total_commission: { currency: 'USD', amount: 150 },
      },
    }))
    expect(amount).toBe(850)
  })

  it('does NOT divide by 100 — Hostex amounts are major units, not cents', () => {
    // The single most likely copy-paste error from the Hospitable mapper,
    // which does /100. Getting it wrong understates every owner P&L by 100x.
    const amount = extractHostexActualTotal(reservation({
      rates: { total_rate: { currency: 'USD', amount: 1234.56 } },
    }))
    expect(amount).toBe(1234.56)
  })

  it('falls back to payment.total_amount when rates are absent', () => {
    const amount = extractHostexActualTotal(reservation({
      payment: { currency: 'USD', total_amount: 500, received_amount: 500, balance_amount: 0, status: 'received' },
    }))
    expect(amount).toBe(500)
  })

  it('returns null rather than a fabricated figure when nothing is present', () => {
    // booking-events.ts then uses its documented avg_nightly_rate estimate.
    expect(extractHostexActualTotal(reservation())).toBeNull()
  })

  it('ignores a commission that would drive the total to zero or below', () => {
    const amount = extractHostexActualTotal(reservation({
      rates: {
        total_rate:       { currency: 'USD', amount: 100 },
        total_commission: { currency: 'USD', amount: 100 },
      },
      payment: { currency: 'USD', total_amount: 100, received_amount: 100, balance_amount: 0, status: 'received' },
    }))
    expect(amount).toBe(100)
  })
})

describe('hostexReservationToNormalized', () => {
  it('uses reservation_code as external_id — Hostex reservations have no id', () => {
    expect(hostexReservationToNormalized(reservation()).external_id).toBe('HX-001')
  })

  it('stringifies property_id so it matches the property map key', () => {
    // hostexPropertyToNormalized writes String(prop.id); a number here would
    // miss every lookup and silently drop every reservation as "unmapped".
    const n = hostexReservationToNormalized(reservation())
    expect(n.property_external_id).toBe('4242')
  })

  it('formats check-in/out times from { hour, minute }', () => {
    const n = hostexReservationToNormalized(reservation({
      check_in_details: { arrival_at: { hour: 9, minute: 5 }, departure_at: { hour: 14, minute: 30 } },
    }))
    expect(n.checkin_time).toBe('09:05')
    expect(n.checkout_time).toBe('14:30')
  })

  it('falls back to house defaults for absent or out-of-range times', () => {
    const n = hostexReservationToNormalized(reservation({
      check_in_details: { arrival_at: { hour: 99, minute: 0 }, departure_at: null },
    }))
    expect(n.checkin_time).toBe('15:00')
    expect(n.checkout_time).toBe('11:00')
  })

  it('marks every reservation a guest stay and never a block', () => {
    // Hostex has no owner-stay concept, and blocks never appear on
    // /reservations at all.
    const n = hostexReservationToNormalized(reservation())
    expect(n.stay_type).toBe('guest_stay')
    expect(n.is_block).toBe(false)
  })
})
