import { describe, it, expect } from 'vitest'
import {
  mapOwnerRezBookingStatus,
  mapOwnerRezChannelToSource,
  normalizeOwnerRezAmenities,
  buildOwnerRezDetailPatch,
} from '@/lib/integrations/providers/ownerrez'
import type {
  OwnerRezProperty,
  OwnerRezListing,
  OwnerRezListingAmenityCategory,
} from '@/lib/integrations/types'

describe('mapOwnerRezBookingStatus', () => {
  it('maps confirmed', () => {
    expect(mapOwnerRezBookingStatus('Confirmed')).toBe('confirmed')
  })

  it('maps cancelled and canceled (both spellings)', () => {
    expect(mapOwnerRezBookingStatus('Cancelled')).toBe('cancelled')
    expect(mapOwnerRezBookingStatus('Canceled')).toBe('cancelled')
  })

  it('maps tentative', () => {
    expect(mapOwnerRezBookingStatus('Tentative')).toBe('tentative')
  })

  it('defaults unknown statuses to confirmed', () => {
    expect(mapOwnerRezBookingStatus('hold')).toBe('confirmed')
  })
})

describe('mapOwnerRezChannelToSource', () => {
  it('maps airbnb', () => {
    expect(mapOwnerRezChannelToSource('Airbnb (API)')).toBe('airbnb')
  })

  it('maps vrbo and homeaway to vrbo', () => {
    expect(mapOwnerRezChannelToSource('VRBO')).toBe('vrbo')
    expect(mapOwnerRezChannelToSource('HomeAway')).toBe('vrbo')
  })

  it('maps booking.com', () => {
    expect(mapOwnerRezChannelToSource('Booking.com')).toBe('booking_com')
  })

  it('maps direct', () => {
    expect(mapOwnerRezChannelToSource('Direct')).toBe('direct')
  })

  it('defaults unrecognized channels to other', () => {
    expect(mapOwnerRezChannelToSource('Some Other Channel')).toBe('other')
  })

  it('defaults missing channel to other', () => {
    expect(mapOwnerRezChannelToSource(undefined)).toBe('other')
  })
})

describe('normalizeOwnerRezAmenities', () => {
  it('flattens nested amenity_categories into a slug -> true map', () => {
    const categories: OwnerRezListingAmenityCategory[] = [
      {
        type: 'pool_and_spa',
        caption: 'Pool and Spa',
        amenities: [
          { icon: 'pool', text: 'Private Pool', title: 'Private Pool' },
          { icon: 'hot-tub', text: 'Hot Tub', title: 'Hot Tub' },
        ],
      },
      {
        type: 'outdoor_features',
        caption: 'Outdoor Features',
        amenities: [{ icon: 'fire', text: 'Fire Pit', title: 'Fire Pit' }],
      },
    ]

    expect(normalizeOwnerRezAmenities(categories)).toEqual({
      private_pool: true,
      hot_tub: true,
      fire_pit: true,
    })
  })

  it('returns an empty object for an empty categories array', () => {
    expect(normalizeOwnerRezAmenities([])).toEqual({})
  })

  it('skips amenities with an empty title', () => {
    const categories: OwnerRezListingAmenityCategory[] = [
      {
        type: 'outdoor_features',
        caption: 'Outdoor Features',
        amenities: [{ icon: 'fire', text: 'Fire Pit', title: '' }],
      },
    ]
    expect(normalizeOwnerRezAmenities(categories)).toEqual({})
  })
})

function baseDetail(overrides: Partial<OwnerRezProperty> = {}): OwnerRezProperty {
  return {
    id: 1,
    name: 'Bear Hollow Cabin',
    bedrooms: 3,
    bathrooms: 2,
    max_occupancy: 8,
    addresses: [
      {
        street1: '123 Forest Rd',
        city: 'Gatlinburg',
        state: 'TN',
        postal_code: '37738',
        is_default: true,
      },
    ],
    latitude: 35.7,
    longitude: -83.3,
    max_guests: 8,
    smoking_allowed: false,
    pets_allowed: true,
    max_pets: 2,
    events_allowed: false,
    min_renter_age: 25,
    ...overrides,
  }
}

function baseListing(overrides: Partial<OwnerRezListing> = {}): OwnerRezListing {
  return {
    property_id: 1,
    wifi_network: 'BearHollowWifi',
    wifi_password: 'letmein123',
    check_in_instructions: 'Lockbox code is 1234.',
    house_manual: 'Please take out trash on Tuesdays.',
    internet_info: null,
    directions: null,
    occupancy_max: 8,
    sleeps_max: 8,
    amenity_categories: [
      {
        type: 'pool_and_spa',
        caption: 'Pool and Spa',
        amenities: [{ icon: 'pool', text: 'Private Pool', title: 'Private Pool' }],
      },
    ],
    amenity_call_outs: [],
    ...overrides,
  }
}

const emptyExisting = {
  wifi_name: null,
  wifi_password: null,
  access_instructions: null,
  house_manual: null,
}

describe('buildOwnerRezDetailPatch', () => {
  it('maps every field on the happy path', () => {
    const patch = buildOwnerRezDetailPatch(emptyExisting, baseDetail(), baseListing())

    expect(patch).toEqual({
      address: '123 Forest Rd',
      state: 'TN',
      city: 'Gatlinburg',
      zip: '37738',
      lat: 35.7,
      lng: -83.3,
      max_guests: 8,
      smoking_allowed: false,
      pets_allowed: true,
      max_pets: 2,
      events_allowed: false,
      min_renter_age: 25,
      wifi_name: 'BearHollowWifi',
      wifi_password: 'letmein123',
      access_instructions: 'Lockbox code is 1234.',
      house_manual: 'Please take out trash on Tuesdays.',
      amenities: { private_pool: true },
    })
  })

  it('preserves a legitimate 0 value for latitude/longitude instead of skipping it', () => {
    const patch = buildOwnerRezDetailPatch(
      emptyExisting,
      baseDetail({ latitude: 0, longitude: 0 }),
      undefined
    )
    expect(patch.lat).toBe(0)
    expect(patch.lng).toBe(0)
  })

  it('preserves explicit false for smoking_allowed/pets_allowed/events_allowed', () => {
    const patch = buildOwnerRezDetailPatch(
      emptyExisting,
      baseDetail({ smoking_allowed: false, pets_allowed: false, events_allowed: false }),
      undefined
    )
    expect(patch.smoking_allowed).toBe(false)
    expect(patch.pets_allowed).toBe(false)
    expect(patch.events_allowed).toBe(false)
  })

  it('preserves a legitimate 0 for max_pets and min_renter_age', () => {
    const patch = buildOwnerRezDetailPatch(
      emptyExisting,
      baseDetail({ max_pets: 0, min_renter_age: 0 }),
      undefined
    )
    expect(patch.max_pets).toBe(0)
    expect(patch.min_renter_age).toBe(0)
  })

  it('omits detail-derived fields entirely when detail is null', () => {
    const patch = buildOwnerRezDetailPatch(emptyExisting, null, undefined)
    expect(patch).toEqual({})
  })

  it('falls back to the first address when none is marked is_default', () => {
    const patch = buildOwnerRezDetailPatch(
      emptyExisting,
      baseDetail({
        addresses: [
          { street1: '456 Other St', city: 'Pigeon Forge', state: 'TN', postal_code: '37863', is_default: false },
        ],
      }),
      undefined
    )
    expect(patch.address).toBe('456 Other St')
    expect(patch.city).toBe('Pigeon Forge')
  })

  it('omits address fields when addresses is empty', () => {
    const patch = buildOwnerRezDetailPatch(emptyExisting, baseDetail({ addresses: [] }), undefined)
    expect(patch.address).toBeUndefined()
    expect(patch.city).toBeUndefined()
    expect(patch.state).toBeUndefined()
    expect(patch.zip).toBeUndefined()
  })

  it('fills wifi/instructions/house_manual only when existing value is null', () => {
    const patch = buildOwnerRezDetailPatch(
      {
        wifi_name: 'ExistingWifi',
        wifi_password: null,
        access_instructions: 'Existing instructions',
        house_manual: null,
      },
      null,
      baseListing()
    )
    expect(patch.wifi_name).toBeUndefined() // existing value wins, not overwritten
    expect(patch.wifi_password).toBe('letmein123') // was null, now filled
    expect(patch.access_instructions).toBeUndefined() // existing value wins
    expect(patch.house_manual).toBe('Please take out trash on Tuesdays.') // was null, now filled
  })

  it('omits listing-derived fields entirely when listing is undefined', () => {
    const patch = buildOwnerRezDetailPatch(emptyExisting, null, undefined)
    expect(patch.wifi_name).toBeUndefined()
    expect(patch.amenities).toBeUndefined()
  })

  it('omits amenities when amenity_categories is empty', () => {
    const patch = buildOwnerRezDetailPatch(
      emptyExisting,
      null,
      baseListing({ amenity_categories: [] })
    )
    expect(patch.amenities).toBeUndefined()
  })

  it('does not fill wifi/instructions from falsy-but-present listing values', () => {
    const patch = buildOwnerRezDetailPatch(
      emptyExisting,
      null,
      baseListing({ wifi_network: null, check_in_instructions: null, house_manual: null })
    )
    expect(patch.wifi_name).toBeUndefined()
    expect(patch.access_instructions).toBeUndefined()
    expect(patch.house_manual).toBeUndefined()
  })
})
