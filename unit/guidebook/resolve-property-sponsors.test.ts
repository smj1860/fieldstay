import { describe, it, expect } from 'vitest'

import { selectAutoSponsors } from '@/lib/guidebook/resolve-property-sponsors'
import { MAX_SPONSORS_PER_PROPERTY } from '@/lib/guidebook/assignment-constants'

// ============================================================================
// The automatic selection rule.
//
// Tested as a pure function rather than through the database, because the one
// property that actually matters here — determinism — is a property of the
// FUNCTION. This runs on a public guest page, and two loads a second apart
// showing different sponsors is a correctness bug, not a cosmetic one.
// ============================================================================

type Row = Parameters<typeof selectAutoSponsors>[0][number]

let seq = 0
const sponsor = (over: Partial<Row> = {}): Row => ({
  id:                   `sp_${++seq}`,
  org_id:               'org_1',
  business_name:        'A Business',
  offer_type:           'none',
  offer_value:          null,
  offer_item:           null,
  custom_offer_text:    null,
  lat:                  null,
  lng:                  null,
  slot_type:            'general',
  status:               'active',
  business_description: null,
  address:              null,
  featured_item:        null,
  business_phone:       null,
  business_website:     null,
  photo_storage_path:   null,
  ...over,
})

// Lake Martin, roughly. The offsets below are ~1 mile per 0.0145 degrees.
const PROPERTY = { lat: 32.5, lng: -85.9 }

describe('selectAutoSponsors — one per named category', () => {
  it('takes the nearest sponsor in each of the four named categories', () => {
    const picked = selectAutoSponsors([
      sponsor({ id: 'brew_far',   slot_type: 'morning_brew',      lat: 32.60, lng: -85.90 }),
      sponsor({ id: 'brew_near',  slot_type: 'morning_brew',      lat: 32.51, lng: -85.90 }),
      sponsor({ id: 'dinner',     slot_type: 'dinner_pints',      lat: 32.52, lng: -85.90 }),
      sponsor({ id: 'rain',       slot_type: 'rainy_day',         lat: 32.53, lng: -85.90 }),
      sponsor({ id: 'outdoor',    slot_type: 'outdoor_adventure', lat: 32.54, lng: -85.90 }),
    ], PROPERTY)

    expect(picked.map((s) => s.id)).toEqual(['brew_near', 'dinner', 'rain', 'outdoor'])
  })

  it('never returns two sponsors of the same named category', () => {
    const picked = selectAutoSponsors([
      sponsor({ id: 'brew_a', slot_type: 'morning_brew', lat: 32.51, lng: -85.90 }),
      sponsor({ id: 'brew_b', slot_type: 'morning_brew', lat: 32.52, lng: -85.90 }),
      sponsor({ id: 'brew_c', slot_type: 'morning_brew', lat: 32.53, lng: -85.90 }),
    ], PROPERTY)

    expect(picked).toHaveLength(1)
    expect(picked[0].id).toBe('brew_a')
  })

  it('marks every automatic pick as `nearest`, with the distance it used', () => {
    const picked = selectAutoSponsors(
      [sponsor({ id: 'brew', slot_type: 'morning_brew', lat: 32.51, lng: -85.90 })],
      PROPERTY,
    )

    expect(picked[0].assignedBy).toBe('nearest')
    expect(picked[0].distanceMiles).toBeGreaterThan(0)
    expect(picked[0].distanceMiles).toBeLessThan(2)
  })
})

describe('selectAutoSponsors — filling from general and other', () => {
  it('fills remaining slots from general, and allows SEVERAL of them', () => {
    const picked = selectAutoSponsors([
      sponsor({ id: 'brew',  slot_type: 'morning_brew', lat: 32.51, lng: -85.90 }),
      sponsor({ id: 'gen_a', slot_type: 'general',      lat: 32.52, lng: -85.90 }),
      sponsor({ id: 'gen_b', slot_type: 'general',      lat: 32.53, lng: -85.90 }),
    ], PROPERTY)

    // general/other are the escape hatch for a business that fits no named
    // category — the one-per-category rule deliberately does not apply.
    expect(picked.map((s) => s.id)).toEqual(['brew', 'gen_a', 'gen_b'])
  })

  it('prefers general over other when both are available', () => {
    const picked = selectAutoSponsors([
      sponsor({ id: 'other_near', slot_type: 'other',   lat: 32.501, lng: -85.90 }),
      sponsor({ id: 'gen_far',    slot_type: 'general', lat: 32.60,  lng: -85.90 }),
    ], PROPERTY)

    expect(picked.map((s) => s.id)).toEqual(['gen_far', 'other_near'])
  })

  it('never returns more than the cap', () => {
    const picked = selectAutoSponsors([
      sponsor({ slot_type: 'morning_brew',      lat: 32.51, lng: -85.90 }),
      sponsor({ slot_type: 'dinner_pints',      lat: 32.52, lng: -85.90 }),
      sponsor({ slot_type: 'rainy_day',         lat: 32.53, lng: -85.90 }),
      sponsor({ slot_type: 'outdoor_adventure', lat: 32.54, lng: -85.90 }),
      sponsor({ slot_type: 'general',           lat: 32.55, lng: -85.90 }),
      sponsor({ slot_type: 'other',             lat: 32.56, lng: -85.90 }),
    ], PROPERTY)

    expect(picked).toHaveLength(MAX_SPONSORS_PER_PROPERTY)
  })

  it('never returns the same business twice', () => {
    const picked = selectAutoSponsors([
      sponsor({ id: 'gen_a', slot_type: 'general' }),
      sponsor({ id: 'gen_b', slot_type: 'general' }),
      sponsor({ id: 'gen_c', slot_type: 'general' }),
    ], PROPERTY)

    expect(new Set(picked.map((s) => s.id)).size).toBe(picked.length)
  })
})

describe('selectAutoSponsors — determinism', () => {
  // pickNearestSponsor falls back to sponsors[0] when NOTHING in the pool has
  // coordinates, so input order decides the output. On a public guest page
  // that makes ordering a correctness requirement, which is why every query
  // feeding this is `.order('id')`.
  const coordless = [
    sponsor({ id: 'a', slot_type: 'general' }),
    sponsor({ id: 'b', slot_type: 'general' }),
    sponsor({ id: 'c', slot_type: 'general' }),
    sponsor({ id: 'd', slot_type: 'general' }),
    sponsor({ id: 'e', slot_type: 'general' }),
  ]

  it('returns identical results on repeated calls with a coordinate-less pool', () => {
    const first  = selectAutoSponsors(coordless, PROPERTY)
    const second = selectAutoSponsors(coordless, PROPERTY)

    expect(first.map((s) => s.id)).toEqual(second.map((s) => s.id))
  })

  it('is stable across many runs, not merely twice', () => {
    const runs = Array.from({ length: 25 }, () =>
      selectAutoSponsors(coordless, PROPERTY).map((s) => s.id).join(','))

    expect(new Set(runs).size).toBe(1)
  })

  it('claims no mileage it could not compute when the PROPERTY has no coordinates', () => {
    const picked = selectAutoSponsors([
      sponsor({ id: 'brew', slot_type: 'morning_brew', lat: 32.51, lng: -85.90 }),
    ], { lat: null, lng: null })

    expect(picked).toHaveLength(1)
    expect(picked[0].distanceMiles).toBeNull()
  })

  it('is deterministic when the property has no coordinates', () => {
    const noCoords = { lat: null, lng: null }
    const first  = selectAutoSponsors(coordless, noCoords).map((s) => s.id)
    const second = selectAutoSponsors(coordless, noCoords).map((s) => s.id)

    expect(first).toEqual(second)
    expect(first).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('selectAutoSponsors — degenerate input', () => {
  it('returns nothing for an org with no active sponsors', () => {
    expect(selectAutoSponsors([], PROPERTY)).toEqual([])
  })

  it('does not treat a sponsor with only one coordinate as locatable', () => {
    // lat without lng is not a position. pickNearestSponsor requires both, so
    // this sponsor is still selected — as the coordinate-less fallback — but
    // must not report a distance.
    const picked = selectAutoSponsors([
      sponsor({ id: 'half', slot_type: 'general', lat: 32.5, lng: null }),
    ], PROPERTY)

    expect(picked).toHaveLength(1)
    expect(picked[0].distanceMiles).toBeNull()
  })
})
