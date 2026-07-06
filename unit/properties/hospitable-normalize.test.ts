import { describe, it, expect } from 'vitest'
import {
  hospitablePropertyToNormalized,
  type HospitableProperty,
} from '@/lib/integrations/providers/hospitable'

// Base fixture matches the shape confirmed live in production (see
// docs/Integrations/hospitable/api-reference.md) for a property with
// include=details — every field populated, no fallbacks exercised.
function baseProperty(overrides: Partial<HospitableProperty> = {}): HospitableProperty {
  return {
    id:            'hosp-prop-1',
    name:          'Bear Hollow Cabin',
    public_name:   'Bear Hollow Cabin #2',
    picture:       null,
    address: {
      number:   '123',
      street:   'Forest Rd',
      city:     'Gatlinburg',
      state:    'TN',
      country:  'US',
      postcode: '37738',
    },
    timezone: '-0500',
    listed:   true,
    checkin:  '16:00',
    checkout: '10:00',
    capacity: {
      max:       8,
      bedrooms:  3,
      beds:      4,
      bathrooms: 2,
    },
    room_details:  [{ type: 'bedroom', beds: [{ type: 'queen', quantity: 1 }] }],
    property_type: 'cabin',
    room_type:     'entire_home',
    amenities:     ['washer', 'dryer', 'dishwasher', 'wireless_internet'],
    currency:      'USD',
    description:   'A cozy cabin in the woods.',
    summary:       'Cozy cabin',
    house_rules: {
      pets_allowed:    true,
      smoking_allowed: false,
      events_allowed:  null,
    },
    tags:                null,
    calendar_restricted: null,
    parent_child:        null,
    details: {
      space_overview:           '',
      guest_access:             'Lockbox code is 1234.',
      house_manual:             'Please take out trash on Tuesdays.',
      other_details:            '',
      additional_rules:         '',
      neighborhood_description: '',
      getting_around:           '',
      wifi_name:                'BearHollowWifi',
      wifi_password:             'letmein123',
    },
    ...overrides,
  }
}

describe('hospitablePropertyToNormalized', () => {
  it('maps every field on the happy path', () => {
    const result = hospitablePropertyToNormalized(baseProperty())

    expect(result.external_id).toBe('hosp-prop-1')
    expect(result.name).toBe('Bear Hollow Cabin #2') // prefers public_name
    expect(result.address).toBe('123 Forest Rd')
    expect(result.city).toBe('Gatlinburg')
    expect(result.state).toBe('TN')
    expect(result.zip).toBe('37738')
    expect(result.bedrooms).toBe(3)
    expect(result.bathrooms).toBe(2)
    expect(result.max_guests).toBe(8)
    expect(result.checkin_time).toBe('16:00')
    expect(result.checkout_time).toBe('10:00')
    expect(result.amenities).toEqual({
      washer: true, dryer: true, dishwasher: true, wireless_internet: true,
    })
    expect(result.smoking_allowed).toBe(false)
    expect(result.pets_allowed).toBe(true)
    expect(result.events_allowed).toBeNull()
    expect(result.wifi_name).toBe('BearHollowWifi')
    expect(result.wifi_password).toBe('letmein123')
    expect(result.access_instructions).toBe('Lockbox code is 1234.')
    expect(result.house_manual).toBe('Please take out trash on Tuesdays.')
  })

  it('falls back to name when public_name is empty', () => {
    const result = hospitablePropertyToNormalized(baseProperty({ public_name: '' }))
    expect(result.name).toBe('Bear Hollow Cabin')
  })

  it('falls back to counting bedroom-type room_details when capacity.bedrooms is null', () => {
    const result = hospitablePropertyToNormalized(baseProperty({
      capacity: { max: 8, bedrooms: null, beds: 4, bathrooms: 2 },
      room_details: [
        { type: 'bedroom', beds: [{ type: 'queen', quantity: 1 }] },
        { type: 'bedroom', beds: [{ type: 'twin', quantity: 2 }] },
        { type: 'living_room', beds: [] },
      ],
    }))
    expect(result.bedrooms).toBe(2)
  })

  it('falls back to 1 bedroom when capacity.bedrooms and room_details are both empty', () => {
    const result = hospitablePropertyToNormalized(baseProperty({
      capacity: { max: 8, bedrooms: null, beds: 4, bathrooms: 2 },
      room_details: [],
    }))
    expect(result.bedrooms).toBe(1)
  })

  it('defaults bathrooms to 1 when capacity.bathrooms is null', () => {
    const result = hospitablePropertyToNormalized(baseProperty({
      capacity: { max: 8, bedrooms: 3, beds: 4, bathrooms: null },
    }))
    expect(result.bathrooms).toBe(1)
  })

  it('defaults max_guests to 2 when capacity.max is null', () => {
    const result = hospitablePropertyToNormalized(baseProperty({
      capacity: { max: null, bedrooms: 3, beds: 4, bathrooms: 2 },
    }))
    expect(result.max_guests).toBe(2)
  })

  it('defaults checkin/checkout to 15:00/11:00 when missing', () => {
    const result = hospitablePropertyToNormalized(baseProperty({
      checkin:  undefined as unknown as string,
      checkout: undefined as unknown as string,
    }))
    expect(result.checkin_time).toBe('15:00')
    expect(result.checkout_time).toBe('11:00')
  })

  it('builds address from number + street, and null when both are missing', () => {
    const withoutAddress = hospitablePropertyToNormalized(baseProperty({
      address: { number: null, street: null, city: 'Gatlinburg', state: 'TN', country: 'US', postcode: '37738' },
    }))
    expect(withoutAddress.address).toBeNull()
  })

  it('returns null for all four content fields when details is null', () => {
    const result = hospitablePropertyToNormalized(baseProperty({ details: null }))
    expect(result.wifi_name).toBeNull()
    expect(result.wifi_password).toBeNull()
    expect(result.access_instructions).toBeNull()
    expect(result.house_manual).toBeNull()
  })

  it('treats empty-string content fields as null, not as an empty string', () => {
    const result = hospitablePropertyToNormalized(baseProperty({
      details: {
        space_overview: '', guest_access: '', house_manual: '',
        other_details: '', additional_rules: '', neighborhood_description: '',
        getting_around: '', wifi_name: '', wifi_password: '',
      },
    }))
    expect(result.access_instructions).toBeNull()
    expect(result.house_manual).toBeNull()
    expect(result.wifi_name).toBeNull()
    expect(result.wifi_password).toBeNull()
  })

  it('returns null amenities when the amenities array is empty', () => {
    const result = hospitablePropertyToNormalized(baseProperty({ amenities: [] }))
    expect(result.amenities).toBeNull()
  })

  it('returns null house_rules fields when house_rules itself is null', () => {
    const result = hospitablePropertyToNormalized(baseProperty({ house_rules: null }))
    expect(result.smoking_allowed).toBeNull()
    expect(result.pets_allowed).toBeNull()
    expect(result.events_allowed).toBeNull()
  })
})
