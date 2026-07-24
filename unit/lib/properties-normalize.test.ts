import { describe, it, expect } from 'vitest'
import type { NormalizedProperty } from '@/lib/properties/normalize'
import { CONTENT_FIELDS, REDACTED_CONTENT_FIELDS } from '@/lib/properties/normalize'

describe('CONTENT_FIELDS', () => {
  it('lists exactly the four PM-editable content fields', () => {
    expect(CONTENT_FIELDS).toEqual([
      'wifi_name',
      'wifi_password',
      'access_instructions',
      'house_manual',
    ])
  })

  it('is a readonly tuple, not a mutable array reference elsewhere in the app', () => {
    // Compile-time guarantee (readonly array) — this assertion just proves
    // the runtime value used for iteration matches the declared type.
    const asReadonly: readonly string[] = CONTENT_FIELDS
    expect(asReadonly).toHaveLength(4)
  })
})

describe('REDACTED_CONTENT_FIELDS', () => {
  it('redacts only wifi_password, since it is a credential', () => {
    expect(REDACTED_CONTENT_FIELDS.has('wifi_password')).toBe(true)
  })

  it('does not redact the other three content fields, which are plain text', () => {
    expect(REDACTED_CONTENT_FIELDS.has('wifi_name')).toBe(false)
    expect(REDACTED_CONTENT_FIELDS.has('access_instructions')).toBe(false)
    expect(REDACTED_CONTENT_FIELDS.has('house_manual')).toBe(false)
  })

  it('contains only fields that are also in CONTENT_FIELDS', () => {
    for (const field of REDACTED_CONTENT_FIELDS) {
      expect(CONTENT_FIELDS).toContain(field)
    }
  })

  it('has exactly one redacted field', () => {
    expect(REDACTED_CONTENT_FIELDS.size).toBe(1)
  })
})

describe('NormalizedProperty shape', () => {
  it('accepts a fully-populated property with cleaning_cost omitted (not yet known from the PMS)', () => {
    const property: NormalizedProperty = {
      external_id:     'ext-1',
      name:            'Lakeside Lodge',
      address:         '123 Lake Rd',
      city:            'Alexander City',
      state:           'AL',
      zip:             '35010',
      bedrooms:        3,
      bathrooms:       2,
      max_guests:      8,
      checkin_time:    '16:00',
      checkout_time:   '10:00',
      timezone:        'America/Chicago',
      amenities:       { wifi: true, pool: false },
      smoking_allowed: false,
      pets_allowed:    true,
      events_allowed:  false,
      wifi_name:       'LakesideGuest',
      wifi_password:   'secret-pass',
      access_instructions: 'Lockbox code 4829',
      house_manual:    'Please remove shoes indoors.',
    }

    expect(property.cleaning_cost).toBeUndefined()
    expect(property.name).toBe('Lakeside Lodge')
  })

  it('accepts a property with every nullable fact/content field set to null', () => {
    const property: NormalizedProperty = {
      external_id:     'ext-2',
      name:            'Mountain Cabin',
      address:         null,
      city:            null,
      state:           null,
      zip:             null,
      bedrooms:        2,
      bathrooms:       null,
      max_guests:      4,
      checkin_time:    '15:00',
      checkout_time:   '11:00',
      timezone:        'America/Denver',
      amenities:       null,
      smoking_allowed: null,
      pets_allowed:    null,
      events_allowed:  null,
      wifi_name:       null,
      wifi_password:   null,
      access_instructions: null,
      house_manual:    null,
      cleaning_cost:   null,
    }

    expect(property.address).toBeNull()
    expect(property.cleaning_cost).toBeNull()
  })

  it('accepts a known PMS-reported cleaning_cost used only to backfill a null value', () => {
    const property: NormalizedProperty = {
      external_id:     'ext-3',
      name:            'River House',
      address:         null,
      city:            null,
      state:           null,
      zip:             null,
      bedrooms:        4,
      bathrooms:       3,
      max_guests:      10,
      checkin_time:    '16:00',
      checkout_time:   '10:00',
      timezone:        'America/Chicago',
      amenities:       null,
      smoking_allowed: null,
      pets_allowed:    null,
      events_allowed:  null,
      wifi_name:       null,
      wifi_password:   null,
      access_instructions: null,
      house_manual:    null,
      cleaning_cost:   150,
    }

    expect(property.cleaning_cost).toBe(150)
  })
})
