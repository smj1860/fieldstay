import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isLodgifyPropertyImportable,
  lodgifyBookingToNormalized,
  lodgifyPropertyToNormalized,
  mapLodgifySource,
  mapLodgifyStatus,
} from '@/lib/integrations/providers/lodgify.mappers'
import type { LodgifyBooking, LodgifyProperty } from '@/lib/integrations/providers/lodgify.types'

// ============================================================================
// The Lodgify mappers carry every judgment call in that integration, and they
// carry MORE risk than the equivalent for any other provider here: their input
// shapes were typed from Lodgify's published documentation, not from a live
// response (there is no connected Lodgify account, and docs.lodgify.com
// refuses automated fetches).
//
// So these tests pin the three rules that decide what a WRONG guess costs:
//
//   1. Absent is never a default — a fabricated room count overwrites the PM's
//      correction on every sync.
//   2. Unrecognised is never silent — an unknown status reports rather than
//      quietly degrading every booking to tentative.
//   3. A field arriving in an unexpected FORM (a numeric string, a timestamp
//      where a date was expected) is coerced rather than discarded, because
//      discarding it is invisible.
// ============================================================================

function property(over: Partial<LodgifyProperty> = {}): LodgifyProperty {
  return { id: 42, name: 'Lakefront Cabin', ...over }
}

function booking(over: Partial<LodgifyBooking> = {}): LodgifyBooking {
  return {
    id:          9001,
    property_id: 42,
    arrival:     '2026-09-01',
    departure:   '2026-09-05',
    status:      'Booked',
    ...over,
  }
}

describe('lodgifyPropertyToNormalized: room counts', () => {
  it('maps an absent count to null, NEVER a guessed default', () => {
    const n = lodgifyPropertyToNormalized(property())
    expect(n.bedrooms).toBeNull()
    expect(n.bathrooms).toBeNull()
    expect(n.max_guests).toBeNull()
  })

  it('reads a count off the property record when it is there', () => {
    const n = lodgifyPropertyToNormalized(property({ bedrooms: 3, bathrooms: 2, max_people: 6 }))
    expect(n.bedrooms).toBe(3)
    expect(n.bathrooms).toBe(2)
    expect(n.max_guests).toBe(6)
  })

  it('falls back to rooms[] when the property record omits the count', () => {
    // Lodgify reports these on the property in some responses and on the room
    // types in others. Reading only one place would import a fully-supplied
    // property as an unknown one.
    const n = lodgifyPropertyToNormalized(property({ rooms: [{ bedrooms: 2, max_people: 4 }] }))
    expect(n.bedrooms).toBe(2)
    expect(n.max_guests).toBe(4)
    expect(n.bathrooms).toBeNull()
  })

  it('preserves a genuine zero — a studio has 0 bedrooms', () => {
    expect(lodgifyPropertyToNormalized(property({ bedrooms: 0 })).bedrooms).toBe(0)
  })
})

describe('lodgifyPropertyToNormalized: coordinates', () => {
  it('accepts coordinates as numbers', () => {
    const n = lodgifyPropertyToNormalized(property({ latitude: 32.84, longitude: -85.92 }))
    expect(n.lat).toBe(32.84)
    expect(n.lng).toBe(-85.92)
  })

  it('accepts coordinates as numeric STRINGS', () => {
    // Lodgify's own examples show both forms. Discarding the string form would
    // silently drop the crew-proximity signal in auto-assign-turnover.ts —
    // invisible, because a coordinate-less property renders identically.
    const n = lodgifyPropertyToNormalized(property({ latitude: '32.84', longitude: '-85.92' }))
    expect(n.lat).toBe(32.84)
    expect(n.lng).toBe(-85.92)
  })

  it('rejects 0/0, which is the Gulf of Guinea rather than a property', () => {
    const n = lodgifyPropertyToNormalized(property({ latitude: 0, longitude: 0 }))
    expect(n.lat).toBeNull()
    expect(n.lng).toBeNull()
  })

  it('rejects unparseable coordinates rather than passing NaN through', () => {
    const n = lodgifyPropertyToNormalized(property({ latitude: 'unknown', longitude: '' }))
    expect(n.lat).toBeNull()
    expect(n.lng).toBeNull()
  })
})

describe('lodgifyPropertyToNormalized: names and content', () => {
  it('prefers the guest-facing name over the internal label', () => {
    const n = lodgifyPropertyToNormalized(property({ name: 'Lakefront Cabin', internal_name: 'LC-01' }))
    expect(n.name).toBe('Lakefront Cabin')
  })

  it('falls back to the internal label, then to an id-bearing label — never empty', () => {
    expect(lodgifyPropertyToNormalized(property({ name: '   ', internal_name: 'LC-01' })).name).toBe('LC-01')
    expect(lodgifyPropertyToNormalized(property({ name: null, internal_name: null })).name).toBe('Lodgify property 42')
  })

  it('leaves every PM-editable content field null so a sync cannot wipe it', () => {
    // upsert-normalized writes null through as "leave the existing value
    // alone". Mapping these to '' would erase whatever the PM typed on EVERY
    // sync, silently.
    const n = lodgifyPropertyToNormalized(property())
    expect(n.wifi_name).toBeNull()
    expect(n.wifi_password).toBeNull()
    expect(n.access_instructions).toBeNull()
    expect(n.house_manual).toBeNull()
  })

  it('maps amenities to null rather than {} — an empty map reads as "confirmed none"', () => {
    expect(lodgifyPropertyToNormalized(property()).amenities).toBeNull()
  })
})

describe('isLodgifyPropertyImportable', () => {
  it('excludes only an EXPLICIT is_active: false', () => {
    expect(isLodgifyPropertyImportable(property({ is_active: false }))).toBe(false)
  })

  it('includes a property that says nothing about is_active', () => {
    // Absence means "Lodgify did not tell us". Treating it as inactive would
    // import ZERO properties from an account whose response differs by one
    // field name — a total failure that reads as "this PM has no listings".
    expect(isLodgifyPropertyImportable(property())).toBe(true)
    expect(isLodgifyPropertyImportable(property({ is_active: true }))).toBe(true)
  })
})

describe('mapLodgifyStatus', () => {
  it('maps the documented vocabulary', () => {
    expect(mapLodgifyStatus('Booked')).toBe('confirmed')
    expect(mapLodgifyStatus('Tentative')).toBe('tentative')
    expect(mapLodgifyStatus('Open')).toBe('tentative')
    expect(mapLodgifyStatus('Declined')).toBe('cancelled')
  })

  it('matches case-insensitively', () => {
    // THE OwnerRez regression, one provider over: a mapper that disagrees with
    // the provider's casing disagrees about EVERY booking, and the whole
    // account lands as tentative — out of revenue, guest email, gap-night
    // offers and conflict detection — while turnovers keep generating, so the
    // integration still looks alive.
    expect(mapLodgifyStatus('booked')).toBe('confirmed')
    expect(mapLodgifyStatus('BOOKED')).toBe('confirmed')
    expect(mapLodgifyStatus('  Booked  ')).toBe('confirmed')
  })

  it('reports an unrecognised status rather than silently defaulting', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(mapLodgifyStatus('Quarantined')).toBe('tentative')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('mapLodgifySource', () => {
  it('reads either source field, since the two spell a channel differently', () => {
    expect(mapLodgifySource({ id: 1, source: 'Airbnb' })).toBe('airbnb')
    expect(mapLodgifySource({ id: 1, source_text: 'Airbnb (API)' })).toBe('airbnb')
    expect(mapLodgifySource({ id: 1, source: 'HomeAway' })).toBe('vrbo')
    expect(mapLodgifySource({ id: 1, source: 'Booking.com' })).toBe('booking_com')
    expect(mapLodgifySource({ id: 1, source: 'Manual' })).toBe('manual')
    expect(mapLodgifySource({ id: 1, source_text: 'Direct website' })).toBe('direct')
  })

  it('sends a channel with no enum member to other, which is what other is for', () => {
    expect(mapLodgifySource({ id: 1, source: 'Agoda' })).toBe('other')
    expect(mapLodgifySource({ id: 1 })).toBe('other')
  })
})

describe('lodgifyBookingToNormalized', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('maps arrival/departure onto checkin/checkout', () => {
    const n = lodgifyBookingToNormalized(booking())
    expect(n.checkin_date).toBe('2026-09-01')
    expect(n.checkout_date).toBe('2026-09-05')
  })

  it('takes the date half of a full timestamp', () => {
    const n = lodgifyBookingToNormalized(booking({ arrival: '2026-09-01T15:00:00Z' }))
    expect(n.checkin_date).toBe('2026-09-01')
  })

  it('rejects a date it cannot parse rather than writing garbage', () => {
    const n = lodgifyBookingToNormalized(booking({ arrival: 'next Tuesday' }))
    expect(n.checkin_date).toBeNull()
  })

  it('treats a trashed booking as cancelled even when its status still says Booked', () => {
    // A trashed booking retains whatever status it held. Believing the status
    // would keep a cancelled stay on the calendar and keep dispatching crew to
    // its turnover.
    expect(lodgifyBookingToNormalized(booking({ is_deleted: true })).status).toBe('cancelled')
    expect(lodgifyBookingToNormalized(booking({ canceled_at: '2026-08-30T10:00:00Z' })).status).toBe('cancelled')
  })

  it('carries the gross total, including when it arrives as a numeric string', () => {
    expect(lodgifyBookingToNormalized(booking({ total_amount: 1450.25 })).actual_total_amount).toBe(1450.25)
    expect(lodgifyBookingToNormalized(booking({ total_amount: '1450.25' })).actual_total_amount).toBe(1450.25)
  })

  it('maps a missing or non-positive total to null, not to 0', () => {
    // 0 would be posted to an owner ledger as real revenue of zero;
    // null lets booking-events.ts fall back to its nights * rate estimate.
    expect(lodgifyBookingToNormalized(booking()).actual_total_amount).toBeNull()
    expect(lodgifyBookingToNormalized(booking({ total_amount: 0 })).actual_total_amount).toBeNull()
    expect(lodgifyBookingToNormalized(booking({ total_amount: 'free' })).actual_total_amount).toBeNull()
  })

  it('defaults an unstated stay to a guest stay, the safe direction', () => {
    // A block mis-read as a stay still produces a turnover; a stay mis-read as
    // a block drops its revenue silently.
    expect(lodgifyBookingToNormalized(booking()).stay_type).toBe('guest_stay')
    expect(lodgifyBookingToNormalized(booking({ is_owner_stay: true })).stay_type).toBe('owner_stay')
  })

  it('stringifies both ids, since the pipeline keys its property map on strings', () => {
    const n = lodgifyBookingToNormalized(booking())
    expect(n.external_id).toBe('9001')
    expect(n.property_external_id).toBe('42')
  })

  it('maps an absent property id to null rather than to the string "null"', () => {
    // The pipeline's unknown-property guard tests for a falsy value; 'null'
    // would sail past it and then match nothing in the map, dropping the stay
    // with a misleading log line.
    expect(lodgifyBookingToNormalized(booking({ property_id: null })).property_external_id).toBeNull()
  })
})
