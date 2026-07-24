import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  normalizeHospitableAmenities,
  hospitablePropertyToNormalized,
  mapHospitableStatus,
  mapHospitableChannel,
  hospitableReservationToNormalized,
  mapHospitableTeammateRole,
  resolveHospitableTeammateName,
  hospitableTeammatesToCrewRows,
  resolveHospitableTimezone,
  extractHospitableTime,
  consolidateHospitableBlocks,
} from '@/lib/integrations/providers/hospitable.mappers'
import type {
  HospitableProperty,
  HospitableReservation,
  HospitableReservationStatus,
  HospitableTeammate,
  HospitableCalendarDay,
} from '@/lib/integrations/providers/hospitable.types'

// ── Fixture factories — full shapes per hospitable.types.ts, overridable per test ──

function baseProperty(overrides: Partial<HospitableProperty> = {}): HospitableProperty {
  return {
    id:            'hosp_prop_1',
    name:          'Internal Name',
    public_name:   'Lakeside Lodge',
    picture:       null,
    address: {
      number:   '123',
      street:   'Lake Rd',
      city:     'Alexander City',
      state:    'AL',
      country:  'US',
      postcode: '35010',
    },
    timezone:      '-0600',
    listed:        true,
    checkin:       '16:00',
    checkout:      '10:00',
    capacity: {
      max:       8,
      bedrooms:  3,
      beds:      4,
      bathrooms: 2,
    },
    room_details:  [],
    property_type: 'house',
    room_type:     'entire_place',
    amenities:     ['ac', 'dishwasher'],
    currency:      'USD',
    description:   '',
    summary:       '',
    house_rules: {
      pets_allowed:    true,
      smoking_allowed: false,
      events_allowed:  false,
    },
    tags:                null,
    calendar_restricted: null,
    parent_child:        null,
    details: {
      space_overview:           null,
      guest_access:             'Lockbox code 4829',
      house_manual:             'Please remove shoes indoors.',
      other_details:            null,
      additional_rules:         null,
      neighborhood_description: null,
      getting_around:           null,
      wifi_name:                'LakesideGuest',
      wifi_password:            'secret-pass',
    },
    bookings: {
      fees: [{ name: 'cleaning_fee', type: 'fixed', value: { amount: 13500, formatted: '$135.00' } }],
    },
    ...overrides,
  }
}

function baseReservationStatus(
  category: HospitableReservationStatus['category'] = 'accepted'
): HospitableReservationStatus {
  return { category, sub_category: '' }
}

function baseReservation(overrides: Partial<HospitableReservation> = {}): HospitableReservation {
  return {
    id:                 'res_1',
    platform:            'airbnb',
    platform_id:         'HMABC123',
    arrival_date:        '2026-08-01T00:00:00-05:00',
    departure_date:      '2026-08-05T00:00:00-05:00',
    check_in:            '2026-08-01T16:00:00-05:00',
    check_out:           '2026-08-05T10:00:00-05:00',
    reservation_status:  { current: baseReservationStatus('accepted') },
    guests: { total: 2, adult_count: 2, child_count: 0, infant_count: 0, pet_count: 0 },
    guest: { first_name: 'Jane', last_name: 'Guest', email: 'jane@example.com', phone_numbers: null },
    properties: [{ id: 'hosp_prop_1', name: 'Internal Name', public_name: 'Lakeside Lodge' }],
    stay_type:  'guest_stay',
    owner_stay: null,
    financials: {
      host:  { revenue: { amount: 45000, formatted: '$450.00' } },
      guest: { total_price: { amount: 52000, formatted: '$520.00' } },
      currency: 'USD',
    },
    ...overrides,
  }
}

function baseTeammate(overrides: Partial<HospitableTeammate> = {}): HospitableTeammate {
  return {
    id:             'team_1',
    name:           'Sam Crew',
    first_name:     'Sam',
    last_name:      'Crew',
    is_company:     false,
    company_name:   null,
    email:          'sam@example.com',
    phone_number:   '5551234567',
    all_services:   false,
    all_properties: true,
    services:       [{ id: 1, label: 'Cleaning' }],
    ...overrides,
  }
}

function calendarDay(overrides: Partial<HospitableCalendarDay> = {}): HospitableCalendarDay {
  return {
    date:                '2026-08-01',
    day:                 'Saturday',
    min_stay:            1,
    note:                null,
    closed_for_checkin:  false,
    closed_for_checkout: false,
    status: {
      reason:      'AVAILABLE',
      source:      null,
      source_type: null,
      available:   true,
    },
    price: { amount: 20000, currency: 'USD', formatted: '$200.00' },
    ...overrides,
  }
}

// ── normalizeHospitableAmenities ──────────────────────────────────────────────

describe('normalizeHospitableAmenities', () => {
  it('converts a flat slug array into a Record<string, boolean> all set to true', () => {
    expect(normalizeHospitableAmenities(['ac', 'dishwasher', 'pool'])).toEqual({
      ac: true, dishwasher: true, pool: true,
    })
  })

  it('returns null for a null input', () => {
    expect(normalizeHospitableAmenities(null)).toBeNull()
  })

  it('returns null for an empty array', () => {
    expect(normalizeHospitableAmenities([])).toBeNull()
  })
})

// ── hospitablePropertyToNormalized ────────────────────────────────────────────

describe('hospitablePropertyToNormalized', () => {
  it('maps a fully-populated property to the NormalizedProperty shape', () => {
    const normalized = hospitablePropertyToNormalized(baseProperty())

    expect(normalized).toEqual({
      external_id:   'hosp_prop_1',
      name:          'Lakeside Lodge',
      address:       '123 Lake Rd',
      city:          'Alexander City',
      state:         'AL',
      zip:           '35010',
      bedrooms:      3,
      bathrooms:     2,
      max_guests:    8,
      checkin_time:  '16:00',
      checkout_time: '10:00',
      timezone:      'America/Chicago',
      amenities:     { ac: true, dishwasher: true },
      smoking_allowed: false,
      pets_allowed:    true,
      events_allowed:  false,
      wifi_name:           'LakesideGuest',
      wifi_password:       'secret-pass',
      access_instructions: 'Lockbox code 4829',
      house_manual:        'Please remove shoes indoors.',
      cleaning_cost:       135,
    })
  })

  it('prefers public_name over the internal name field', () => {
    const normalized = hospitablePropertyToNormalized(
      baseProperty({ name: 'Internal', public_name: 'Public Facing Name' })
    )
    expect(normalized.name).toBe('Public Facing Name')
  })

  it('falls back to the internal name when public_name is empty', () => {
    const normalized = hospitablePropertyToNormalized(baseProperty({ public_name: '' }))
    expect(normalized.name).toBe('Internal Name')
  })

  it('joins address number + street, and returns null when both are absent', () => {
    const withAddr = hospitablePropertyToNormalized(
      baseProperty({ address: { number: '456', street: 'Oak Ave', city: null, state: null, country: null, postcode: null } })
    )
    expect(withAddr.address).toBe('456 Oak Ave')

    const noAddr = hospitablePropertyToNormalized(
      baseProperty({ address: { number: null, street: null, city: null, state: null, country: null, postcode: null } })
    )
    expect(noAddr.address).toBeNull()
  })

  it('uses capacity.bedrooms directly when present, even when it is exactly 0 (a true studio)', () => {
    const normalized = hospitablePropertyToNormalized(
      baseProperty({ capacity: { max: 2, bedrooms: 0, beds: 1, bathrooms: 1 } })
    )
    expect(normalized.bedrooms).toBe(0)
  })

  it('falls back to counting bedroom-type room_details when capacity.bedrooms is null', () => {
    const normalized = hospitablePropertyToNormalized(
      baseProperty({
        capacity: { max: 6, bedrooms: null, beds: 4, bathrooms: 2 },
        room_details: [
          { type: 'bedroom', beds: [{ type: 'queen', quantity: 1 }] },
          { type: 'bedroom', beds: [{ type: 'twin', quantity: 2 }] },
          { type: 'living_room', beds: [] },
        ],
      })
    )
    expect(normalized.bedrooms).toBe(2)
  })

  it('defaults bedrooms to 1 when capacity.bedrooms is null and no bedroom room_details exist', () => {
    const normalized = hospitablePropertyToNormalized(
      baseProperty({ capacity: { max: 2, bedrooms: null, beds: 1, bathrooms: 1 }, room_details: [] })
    )
    expect(normalized.bedrooms).toBe(1)
  })

  it('defaults bathrooms/max_guests/checkin/checkout when their source fields are null', () => {
    const normalized = hospitablePropertyToNormalized(
      baseProperty({
        capacity: { max: null, bedrooms: 2, beds: 2, bathrooms: null },
        checkin:  null as unknown as string,
        checkout: null as unknown as string,
      })
    )
    expect(normalized.bathrooms).toBe(1)
    expect(normalized.max_guests).toBe(2)
    expect(normalized.checkin_time).toBe('15:00')
    expect(normalized.checkout_time).toBe('11:00')
  })

  it('maps house_rules booleans through as-is, including explicit false, and null when house_rules is absent', () => {
    const withRules = hospitablePropertyToNormalized(
      baseProperty({ house_rules: { pets_allowed: false, smoking_allowed: false, events_allowed: true } })
    )
    expect(withRules.pets_allowed).toBe(false)
    expect(withRules.smoking_allowed).toBe(false)
    expect(withRules.events_allowed).toBe(true)

    const noRules = hospitablePropertyToNormalized(baseProperty({ house_rules: null }))
    expect(noRules.pets_allowed).toBeNull()
    expect(noRules.smoking_allowed).toBeNull()
    expect(noRules.events_allowed).toBeNull()
  })

  it('maps content fields to null when details is absent', () => {
    const normalized = hospitablePropertyToNormalized(baseProperty({ details: null }))
    expect(normalized.wifi_name).toBeNull()
    expect(normalized.wifi_password).toBeNull()
    expect(normalized.access_instructions).toBeNull()
    expect(normalized.house_manual).toBeNull()
  })

  it('treats an empty-string wifi_name/house_manual as absent (falls back to null, not "")', () => {
    const normalized = hospitablePropertyToNormalized(
      baseProperty({
        details: {
          space_overview: null, guest_access: '', house_manual: '', other_details: null,
          additional_rules: null, neighborhood_description: null, getting_around: null,
          wifi_name: '', wifi_password: null,
        },
      })
    )
    expect(normalized.wifi_name).toBeNull()
    expect(normalized.access_instructions).toBeNull()
    expect(normalized.house_manual).toBeNull()
  })

  it('returns null cleaning_cost when no bookings.fees are present', () => {
    const normalized = hospitablePropertyToNormalized(baseProperty({ bookings: null }))
    expect(normalized.cleaning_cost).toBeNull()
  })

  it('derives timezone from address.state via resolveHospitableTimezone, ignoring the raw UTC-offset timezone field', () => {
    const normalized = hospitablePropertyToNormalized(
      baseProperty({
        timezone: '+0000', // deliberately wrong/irrelevant — must be ignored
        address:  { number: '1', street: 'Main St', city: 'Reno', state: 'NV', country: 'US', postcode: '89501' },
      })
    )
    expect(normalized.timezone).toBe('America/Los_Angeles')
  })
})

// ── mapHospitableStatus ────────────────────────────────────────────────────────

describe('mapHospitableStatus', () => {
  it('maps "accepted" to "confirmed"', () => {
    expect(mapHospitableStatus('accepted')).toBe('confirmed')
  })

  it.each(['request', 'unknown', 'checkpoint'] as const)(
    'maps "%s" to "tentative"',
    (category) => {
      expect(mapHospitableStatus(category)).toBe('tentative')
    }
  )

  it.each(['cancelled', 'not accepted'] as const)(
    'maps "%s" to "cancelled"',
    (category) => {
      expect(mapHospitableStatus(category)).toBe('cancelled')
    }
  )

  it('falls back to tentative (never confirmed) for a genuinely unrecognized category, and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unforeseen = 'some_new_category' as unknown as HospitableReservationStatus['category']

    expect(mapHospitableStatus(unforeseen)).toBe('tentative')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('hospitable'))
    warnSpy.mockRestore()
  })
})

// ── mapHospitableChannel ───────────────────────────────────────────────────────

describe('mapHospitableChannel', () => {
  it('maps airbnb to airbnb', () => {
    expect(mapHospitableChannel('airbnb')).toBe('airbnb')
  })

  it('maps homeaway to vrbo', () => {
    expect(mapHospitableChannel('homeaway')).toBe('vrbo')
  })

  it('maps booking to booking_com', () => {
    expect(mapHospitableChannel('booking')).toBe('booking_com')
  })

  it('maps both direct and manual to direct', () => {
    expect(mapHospitableChannel('direct')).toBe('direct')
    expect(mapHospitableChannel('manual')).toBe('direct')
  })

  it.each(['agoda', 'ical', 'something_unrecognized'])('maps %s to other', (platform) => {
    expect(mapHospitableChannel(platform)).toBe('other')
  })

  it('is case-insensitive', () => {
    expect(mapHospitableChannel('AirBnB')).toBe('airbnb')
    expect(mapHospitableChannel('HOMEAWAY')).toBe('vrbo')
  })
})

// ── hospitableReservationToNormalized ─────────────────────────────────────────

describe('hospitableReservationToNormalized', () => {
  it('maps a fully-populated confirmed guest-stay reservation to the NormalizedBooking shape', () => {
    const normalized = hospitableReservationToNormalized(baseReservation())

    expect(normalized).toEqual({
      external_id:           'res_1',
      property_external_id:  'hosp_prop_1',
      checkin_date:          '2026-08-01',
      checkout_date:         '2026-08-05',
      checkin_time:          '16:00',
      checkout_time:         '10:00',
      status:                'confirmed',
      guest_name:            'Jane Guest',
      guest_email:           'jane@example.com',
      source:                'airbnb',
      is_block:              false,
      stay_type:             'guest_stay',
      actual_total_amount:   450,
    })
  })

  it('never swaps checkin/checkout: checkin comes from arrival_date/check_in, checkout from departure_date/check_out', () => {
    const normalized = hospitableReservationToNormalized(
      baseReservation({
        arrival_date:   '2026-09-10T00:00:00-05:00',
        departure_date: '2026-09-15T00:00:00-05:00',
        check_in:       '2026-09-10T17:30:00-05:00',
        check_out:      '2026-09-15T09:15:00-05:00',
      })
    )
    expect(normalized.checkin_date).toBe('2026-09-10')
    expect(normalized.checkout_date).toBe('2026-09-15')
    expect(normalized.checkin_time).toBe('17:30')
    expect(normalized.checkout_time).toBe('09:15')
  })

  it('resolves property_external_id from the first entry of the properties array', () => {
    const normalized = hospitableReservationToNormalized(
      baseReservation({ properties: [{ id: 'hosp_prop_9', name: 'X', public_name: 'X' }] })
    )
    expect(normalized.property_external_id).toBe('hosp_prop_9')
  })

  it('returns null property_external_id when properties is absent or empty', () => {
    expect(hospitableReservationToNormalized(baseReservation({ properties: undefined })).property_external_id).toBeNull()
    expect(hospitableReservationToNormalized(baseReservation({ properties: [] })).property_external_id).toBeNull()
  })

  it('combines guest first_name + last_name into guest_name, and captures guest_email', () => {
    const normalized = hospitableReservationToNormalized(
      baseReservation({ guest: { first_name: 'John', last_name: 'Doe', email: 'john@example.com', phone_numbers: null } })
    )
    expect(normalized.guest_name).toBe('John Doe')
    expect(normalized.guest_email).toBe('john@example.com')
  })

  it('returns null guest_name/guest_email when guest is absent (no include=guest)', () => {
    const normalized = hospitableReservationToNormalized(baseReservation({ guest: undefined }))
    expect(normalized.guest_name).toBeNull()
    expect(normalized.guest_email).toBeNull()
  })

  it('handles a guest with only a first name (no last name)', () => {
    const normalized = hospitableReservationToNormalized(
      baseReservation({ guest: { first_name: 'Cher', last_name: null, email: null, phone_numbers: null } })
    )
    expect(normalized.guest_name).toBe('Cher')
  })

  it('returns null guest_name when guest is present but both names are null', () => {
    const normalized = hospitableReservationToNormalized(
      baseReservation({ guest: { first_name: null, last_name: null, email: null, phone_numbers: null } })
    )
    expect(normalized.guest_name).toBeNull()
  })

  it('maps stay_type owner_stay through, and defaults everything else to guest_stay', () => {
    expect(hospitableReservationToNormalized(baseReservation({ stay_type: 'owner_stay' })).stay_type).toBe('owner_stay')
    expect(hospitableReservationToNormalized(baseReservation({ stay_type: undefined })).stay_type).toBe('guest_stay')
  })

  it('always maps is_block to false — real reservations never carry a block signal', () => {
    expect(hospitableReservationToNormalized(baseReservation()).is_block).toBe(false)
  })

  it('maps the channel from platform using mapHospitableChannel', () => {
    expect(hospitableReservationToNormalized(baseReservation({ platform: 'homeaway' })).source).toBe('vrbo')
  })

  it('maps the status from reservation_status.current.category using mapHospitableStatus', () => {
    const normalized = hospitableReservationToNormalized(
      baseReservation({ reservation_status: { current: baseReservationStatus('cancelled') } })
    )
    expect(normalized.status).toBe('cancelled')
  })

  it('prefers host.revenue over guest.total_price for actual_total_amount', () => {
    const normalized = hospitableReservationToNormalized(
      baseReservation({
        financials: {
          host:  { revenue: { amount: 30000, formatted: '$300.00' } },
          guest: { total_price: { amount: 40000, formatted: '$400.00' } },
        },
      })
    )
    expect(normalized.actual_total_amount).toBe(300)
  })

  it('falls back to guest.total_price when host.revenue is absent', () => {
    const normalized = hospitableReservationToNormalized(
      baseReservation({ financials: { guest: { total_price: { amount: 40000, formatted: '$400.00' } } } })
    )
    expect(normalized.actual_total_amount).toBe(400)
  })

  it('returns null actual_total_amount when financials is entirely absent', () => {
    const normalized = hospitableReservationToNormalized(baseReservation({ financials: null }))
    expect(normalized.actual_total_amount).toBeNull()
  })
})

// ── extractHospitableTime ───────────────────────────────────────────────────

describe('extractHospitableTime', () => {
  it('extracts HH:MM from an ISO datetime string', () => {
    expect(extractHospitableTime('2019-01-03T13:00:00-05:00', '15:00')).toBe('13:00')
  })

  it('returns the fallback when the input is null', () => {
    expect(extractHospitableTime(null, '15:00')).toBe('15:00')
  })

  it('returns the fallback when the input is undefined', () => {
    expect(extractHospitableTime(undefined, '11:00')).toBe('11:00')
  })

  it('returns the fallback when the input does not match the expected shape', () => {
    expect(extractHospitableTime('not-a-date', '15:00')).toBe('15:00')
  })
})

// ── mapHospitableTeammateRole ─────────────────────────────────────────────────

describe('mapHospitableTeammateRole', () => {
  it('maps a "Maintenance" service label to maintenance', () => {
    expect(mapHospitableTeammateRole([{ label: 'Maintenance' }])).toBe('maintenance')
  })

  it('maps a "Cleaning" service label to cleaning', () => {
    expect(mapHospitableTeammateRole([{ label: 'Cleaning' }])).toBe('cleaning')
  })

  it('maps a "Laundry" service label to cleaning', () => {
    expect(mapHospitableTeammateRole([{ label: 'Laundry' }])).toBe('cleaning')
  })

  it('prioritizes maintenance over cleaning when both are present, regardless of array order', () => {
    expect(mapHospitableTeammateRole([{ label: 'Cleaning' }, { label: 'Maintenance' }])).toBe('maintenance')
    expect(mapHospitableTeammateRole([{ label: 'Maintenance' }, { label: 'Cleaning' }])).toBe('maintenance')
  })

  it.each(['Check-in', 'Check-out', 'Concierge', 'Manager', 'Owner'])(
    'maps unrecognized service label "%s" to general',
    (label) => {
      expect(mapHospitableTeammateRole([{ label }])).toBe('general')
    }
  )

  it('maps an empty services array to general', () => {
    expect(mapHospitableTeammateRole([])).toBe('general')
  })

  it('is case-insensitive', () => {
    expect(mapHospitableTeammateRole([{ label: 'MAINTENANCE' }])).toBe('maintenance')
  })
})

// ── resolveHospitableTeammateName ─────────────────────────────────────────────

describe('resolveHospitableTeammateName', () => {
  it('prefers the pre-combined name field', () => {
    expect(resolveHospitableTeammateName(baseTeammate({ name: 'Full Name Here' }))).toBe('Full Name Here')
  })

  it('falls back to first_name + last_name when name is absent', () => {
    expect(
      resolveHospitableTeammateName(baseTeammate({ name: null, first_name: 'Sam', last_name: 'Crew' }))
    ).toBe('Sam Crew')
  })

  it('falls back to just first_name when last_name is absent', () => {
    expect(
      resolveHospitableTeammateName(baseTeammate({ name: null, first_name: 'Sam', last_name: null }))
    ).toBe('Sam')
  })

  it('falls back to company_name when the teammate is a company with no personal name', () => {
    expect(
      resolveHospitableTeammateName(
        baseTeammate({ name: null, first_name: null, last_name: null, is_company: true, company_name: 'Acme Cleaning Co' })
      )
    ).toBe('Acme Cleaning Co')
  })

  it('returns null when no name-resolvable field is present', () => {
    expect(
      resolveHospitableTeammateName(
        baseTeammate({ name: null, first_name: null, last_name: null, is_company: false, company_name: null })
      )
    ).toBeNull()
  })

  it('does not fall back to company_name when is_company is false, even if company_name is set', () => {
    expect(
      resolveHospitableTeammateName(
        baseTeammate({ name: null, first_name: null, last_name: null, is_company: false, company_name: 'Some LLC' })
      )
    ).toBeNull()
  })
})

// ── hospitableTeammatesToCrewRows ─────────────────────────────────────────────

describe('hospitableTeammatesToCrewRows', () => {
  it('maps a resolvable teammate to a full crew row', () => {
    const rows = hospitableTeammatesToCrewRows('org_1', [baseTeammate()])

    expect(rows).toEqual([{
      org_id:            'org_1',
      name:              'Sam Crew',
      email:             'sam@example.com',
      phone:             '5551234567',
      role:              'cleaning',
      is_active:         true,
      reliability_score: 1.0,
      capacity_score:    1.0,
      specialty:         'Cleaning',
      external_id:       'team_1',
      external_source:   'hospitable',
    }])
  })

  it('joins multiple service labels with a comma in specialty', () => {
    const rows = hospitableTeammatesToCrewRows('org_1', [
      baseTeammate({ services: [{ id: 1, label: 'Cleaning' }, { id: 2, label: 'Check-in' }] }),
    ])
    expect(rows[0]!.specialty).toBe('Cleaning, Check-in')
  })

  it('sets specialty to null when the teammate has no services', () => {
    const rows = hospitableTeammatesToCrewRows('org_1', [baseTeammate({ services: [] })])
    expect(rows[0]!.specialty).toBeNull()
  })

  it('drops teammates with no resolvable name entirely', () => {
    const rows = hospitableTeammatesToCrewRows('org_1', [
      baseTeammate({ id: 'no_name', name: null, first_name: null, last_name: null, is_company: false, company_name: null }),
      baseTeammate({ id: 'has_name' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.external_id).toBe('has_name')
  })

  it('drops a teammate whose only resolvable name is all-whitespace', () => {
    const rows = hospitableTeammatesToCrewRows('org_1', [
      baseTeammate({ name: '   ' }),
    ])
    expect(rows).toHaveLength(0)
  })

  it('maps null email/phone through as null', () => {
    const rows = hospitableTeammatesToCrewRows('org_1', [baseTeammate({ email: null, phone_number: null })])
    expect(rows[0]!.email).toBeNull()
    expect(rows[0]!.phone).toBeNull()
  })

  it('returns an empty array for an empty input list', () => {
    expect(hospitableTeammatesToCrewRows('org_1', [])).toEqual([])
  })
})

// ── resolveHospitableTimezone ──────────────────────────────────────────────────

describe('resolveHospitableTimezone', () => {
  it('ignores the raw Hospitable UTC-offset timezone field entirely', () => {
    // Even a wildly wrong-looking offset must not affect the result — the
    // function derives solely from state.
    expect(resolveHospitableTimezone('+9999', 'AL')).toBe('America/Chicago')
  })

  it('maps an Eastern state to America/New_York', () => {
    expect(resolveHospitableTimezone('-0500', 'FL')).toBe('America/New_York')
  })

  it('maps Michigan to America/Detroit specifically (not the generic Eastern zone)', () => {
    expect(resolveHospitableTimezone('-0500', 'MI')).toBe('America/Detroit')
  })

  it('maps Indiana to America/Indiana/Indianapolis', () => {
    expect(resolveHospitableTimezone('-0500', 'IN')).toBe('America/Indiana/Indianapolis')
  })

  it('maps Arizona to the no-DST America/Phoenix zone', () => {
    expect(resolveHospitableTimezone('-0700', 'AZ')).toBe('America/Phoenix')
  })

  it('maps Idaho to America/Boise', () => {
    expect(resolveHospitableTimezone('-0700', 'ID')).toBe('America/Boise')
  })

  it('maps Hawaii and Alaska to their respective non-contiguous zones', () => {
    expect(resolveHospitableTimezone(null, 'HI')).toBe('Pacific/Honolulu')
    expect(resolveHospitableTimezone(null, 'AK')).toBe('America/Anchorage')
  })

  it('is case-insensitive and trims whitespace on the state code', () => {
    expect(resolveHospitableTimezone(null, ' al ')).toBe('America/Chicago')
    expect(resolveHospitableTimezone(null, 'ca')).toBe('America/Los_Angeles')
  })

  it('defaults to America/Chicago for a null, undefined, or unrecognized state', () => {
    expect(resolveHospitableTimezone(null, null)).toBe('America/Chicago')
    expect(resolveHospitableTimezone(null, undefined)).toBe('America/Chicago')
    expect(resolveHospitableTimezone(null, 'ZZ')).toBe('America/Chicago')
  })
})

// ── consolidateHospitableBlocks ────────────────────────────────────────────────

describe('consolidateHospitableBlocks', () => {
  it('merges consecutive manually-blocked days into a single range, checkout the day after the last blocked night', () => {
    const days = [
      calendarDay({ date: '2026-08-01', status: { reason: 'BLOCKED', source: null, source_type: 'USER', available: false } }),
      calendarDay({ date: '2026-08-02', status: { reason: 'BLOCKED', source: null, source_type: 'USER', available: false } }),
      calendarDay({ date: '2026-08-03', status: { reason: 'BLOCKED', source: null, source_type: 'USER', available: false } }),
    ]
    expect(consolidateHospitableBlocks(days)).toEqual([
      { checkin_date: '2026-08-01', checkout_date: '2026-08-04' },
    ])
  })

  it('does not treat a real reservation (source_type RESERVATION) as a manual block', () => {
    const days = [
      calendarDay({ date: '2026-08-01', status: { reason: 'RESERVED', source: null, source_type: 'RESERVATION', available: false } }),
    ]
    expect(consolidateHospitableBlocks(days)).toEqual([])
  })

  it('does not treat an available day as blocked, even if source_type is USER', () => {
    const days = [
      calendarDay({ date: '2026-08-01', status: { reason: 'AVAILABLE', source: null, source_type: 'USER', available: true } }),
    ]
    expect(consolidateHospitableBlocks(days)).toEqual([])
  })

  it('splits into separate ranges when blocked days are not consecutive', () => {
    const blocked = (date: string) => calendarDay({ date, status: { reason: 'BLOCKED', source: null, source_type: 'USER', available: false } })
    const available = (date: string) => calendarDay({ date, status: { reason: 'AVAILABLE', source: null, source_type: 'USER', available: true } })

    const days = [blocked('2026-08-01'), blocked('2026-08-02'), available('2026-08-03'), blocked('2026-08-05')]

    expect(consolidateHospitableBlocks(days)).toEqual([
      { checkin_date: '2026-08-01', checkout_date: '2026-08-03' },
      { checkin_date: '2026-08-05', checkout_date: '2026-08-06' },
    ])
  })

  it('closes a trailing open range at the end of the input array', () => {
    const days = [
      calendarDay({ date: '2026-08-01', status: { reason: 'AVAILABLE', source: null, source_type: null, available: true } }),
      calendarDay({ date: '2026-08-02', status: { reason: 'BLOCKED', source: null, source_type: 'USER', available: false } }),
    ]
    expect(consolidateHospitableBlocks(days)).toEqual([
      { checkin_date: '2026-08-02', checkout_date: '2026-08-03' },
    ])
  })

  it('handles a single blocked day producing a one-night range', () => {
    const days = [
      calendarDay({ date: '2026-12-31', status: { reason: 'BLOCKED', source: null, source_type: 'USER', available: false } }),
    ]
    expect(consolidateHospitableBlocks(days)).toEqual([
      { checkin_date: '2026-12-31', checkout_date: '2027-01-01' },
    ])
  })

  it('returns an empty array for an empty input', () => {
    expect(consolidateHospitableBlocks([])).toEqual([])
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
