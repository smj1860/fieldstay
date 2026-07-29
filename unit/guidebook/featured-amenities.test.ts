import { describe, it, expect } from 'vitest'
import {
  MAX_FEATURED_AMENITIES,
  prettifyAmenityKey,
  resolveFeaturedAmenities,
  daysSinceCheckin,
  buildFeaturedAmenityLine,
} from '@/lib/guidebook/featured-amenities'

describe('prettifyAmenityKey', () => {
  it('title-cases a raw Hospitable-style slug', () => {
    expect(prettifyAmenityKey('hot_tub')).toBe('Hot Tub')
  })

  it('is idempotent on an already Title Case OwnerRez-style key', () => {
    expect(prettifyAmenityKey('Fire Pit')).toBe('Fire Pit')
  })

  it('handles a single-word key', () => {
    expect(prettifyAmenityKey('kayaks')).toBe('Kayaks')
  })
})

describe('resolveFeaturedAmenities', () => {
  it('uses the PM\'s explicit selection when present', () => {
    const result = resolveFeaturedAmenities(['Hot Tub', 'Fire Pit'], { 'Hot Tub': true, Pool: true })
    expect(result).toEqual(['Hot Tub', 'Fire Pit'])
  })

  it('clamps an oversized configured list to the max', () => {
    const result = resolveFeaturedAmenities(['A', 'B', 'C', 'D'], null)
    expect(result).toEqual(['A', 'B', 'C'])
    expect(result.length).toBeLessThanOrEqual(MAX_FEATURED_AMENITIES)
  })

  it('falls back to the first synced amenities when the PM configured nothing', () => {
    const result = resolveFeaturedAmenities(null, {
      'Hot Tub': true, 'Fire Pit': true, Pool: true, Kayaks: true,
    })
    expect(result).toEqual(['Hot Tub', 'Fire Pit', 'Pool'])
  })

  it('falls back when the PM configured an empty array', () => {
    const result = resolveFeaturedAmenities([], { 'Hot Tub': true })
    expect(result).toEqual(['Hot Tub'])
  })

  it('excludes synced amenities that are explicitly false', () => {
    const result = resolveFeaturedAmenities(null, { 'Hot Tub': true, Pool: false })
    expect(result).toEqual(['Hot Tub'])
  })

  it('returns an empty array when there is nothing configured or synced', () => {
    expect(resolveFeaturedAmenities(null, null)).toEqual([])
    expect(resolveFeaturedAmenities(null, {})).toEqual([])
  })
})

describe('daysSinceCheckin', () => {
  it('returns 0 on the check-in day itself', () => {
    expect(daysSinceCheckin('2026-07-20', '2026-07-20')).toBe(0)
  })

  it('counts whole days elapsed', () => {
    expect(daysSinceCheckin('2026-07-20', '2026-07-23')).toBe(3)
  })

  it('clamps to 0 rather than going negative for a date before check-in', () => {
    expect(daysSinceCheckin('2026-07-20', '2026-07-18')).toBe(0)
  })
})

describe('buildFeaturedAmenityLine', () => {
  it('returns null when there are no featured amenities at all', () => {
    expect(buildFeaturedAmenityLine([], null, 0)).toBeNull()
  })

  it('uses the PM\'s own note at the matching rotation position', () => {
    const line = buildFeaturedAmenityLine(
      ['Hot Tub', 'Fire Pit', 'Kayaks'],
      'Takes 45 min to heat.; Starter logs on back porch.; Life jackets in the shed.',
      1,
    )
    expect(line).toBe('Starter logs on back porch.')
  })

  it('tolerates a comma inside a single note without shifting the others out of position', () => {
    const line = buildFeaturedAmenityLine(
      ['Hot Tub', 'Fire Pit'],
      'Takes 45 min to heat, so start it early.; Starter logs on back porch.',
      1,
    )
    expect(line).toBe('Starter logs on back porch.')
  })

  it('falls back to a generic mention when the PM left that position blank', () => {
    const line = buildFeaturedAmenityLine(['Hot Tub', 'Fire Pit'], 'Takes 45 min to heat.', 1)
    expect(line).toBe('This property has a Fire Pit.')
  })

  it('does not let a blank middle note shift a later note into the wrong position', () => {
    const keys = ['Hot Tub', 'Fire Pit', 'Kayaks']
    // Fire Pit's note deliberately left blank — Kayaks' note must stay at
    // index 2, not get compacted into index 1.
    const notes = 'Takes 45 min to heat.;;Life jackets in the shed.'
    expect(buildFeaturedAmenityLine(keys, notes, 1)).toBe('This property has a Fire Pit.')
    expect(buildFeaturedAmenityLine(keys, notes, 2)).toBe('Life jackets in the shed.')
  })

  it('falls back to a generic mention when no notes were written at all', () => {
    const line = buildFeaturedAmenityLine(['Hot Tub'], null, 0)
    expect(line).toBe('This property has a Hot Tub.')
  })

  it('rotates through amenities as the index grows, wrapping around', () => {
    const keys = ['Hot Tub', 'Fire Pit', 'Kayaks']
    expect(buildFeaturedAmenityLine(keys, null, 0)).toBe('This property has a Hot Tub.')
    expect(buildFeaturedAmenityLine(keys, null, 1)).toBe('This property has a Fire Pit.')
    expect(buildFeaturedAmenityLine(keys, null, 2)).toBe('This property has a Kayaks.')
    expect(buildFeaturedAmenityLine(keys, null, 3)).toBe('This property has a Hot Tub.')
  })
})
