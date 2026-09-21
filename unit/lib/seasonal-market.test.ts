import { describe, it, expect } from 'vitest'

import {
  normalizeZip, seasonalProfileForZip, resolveSeasonalProfile,
} from '@/lib/scoring/seasonal-market'

// The profile describes a MARKET, not a house, and is derived from the ZIP so
// no PM is ever asked to classify a property. An unmapped ZIP scores 'none',
// which contributes 0 — the same honest absence as before.

describe('normalizeZip', () => {
  it('accepts the shapes the live properties.zip column actually holds', () => {
    // All three are real values from production: ZIP+4, a state prefix pasted
    // into the field, and a tidy one. Keying on the raw string would have
    // missed the first two — the same failure properties.state had.
    expect(normalizeZip('36850-3722')).toBe('36850')
    expect(normalizeZip('TX 78703')).toBe('78703')
    expect(normalizeZip('35010')).toBe('35010')
    expect(normalizeZip('  32501  ')).toBe('32501')
  })

  it('returns null when there is no ZIP in the value at all', () => {
    expect(normalizeZip(null)).toBeNull()
    expect(normalizeZip(undefined)).toBeNull()
    expect(normalizeZip('')).toBeNull()
    expect(normalizeZip('N/A')).toBeNull()
    expect(normalizeZip('1234')).toBeNull() // four digits is not a ZIP
  })
})

describe('seasonalProfileForZip', () => {
  it.each([
    ['35010', ['summer_vacation'],   'Alexander City AL — Lake Martin'],
    ['36853', ['summer_vacation'],   'Dadeville AL'],
    ['36561', ['summer_vacation'],   'Orange Beach AL — coastal, same value as lake'],
    ['32501', ['summer_vacation'],   'Pensacola FL'],
    ['22835', ['fall_foliage'],      'Luray VA — Shenandoah'],
    ['80424', ['ski'],               'Breckenridge CO'],
    ['84060', ['ski'],               'Park City UT'],
    ['78703', ['year_round_urban'],  'Austin TX'],
    ['80829', ['summer_vacation'],   'Manitou Springs CO — summer-peaked mountain'],
  ])('%s -> %s (%s)', (zip, expected) => {
    expect(seasonalProfileForZip(zip)).toEqual(expected)
  })

  it('gives the Smokies BOTH seasons — the case the array exists for', () => {
    // Real summer national-park tourism AND a real October colour run. As a
    // scalar this was a forced either/or.
    for (const zip of ['37738', '37862', '37863', '37876']) {
      expect(seasonalProfileForZip(zip)).toEqual(['summer_vacation', 'fall_foliage'])
    }
  })

  it('reads a ZIP+4 and a prefixed value the same as the bare ZIP', () => {
    // Two live rows: '36850-3722' and 'TX 78703'.
    expect(seasonalProfileForZip('36850-3722')).toEqual(['summer_vacation'])
    expect(seasonalProfileForZip('TX 78703')).toEqual(['year_round_urban'])
  })

  it('returns an empty array for an unmapped or missing ZIP rather than guessing', () => {
    // A neighbouring ZIP is not evidence. Empty contributes 0, which is the
    // honest answer for a market nobody has mapped.
    expect(seasonalProfileForZip('30157')).toEqual([]) // suburban Atlanta
    expect(seasonalProfileForZip('99999')).toEqual([])
    expect(seasonalProfileForZip(null)).toEqual([])
    expect(seasonalProfileForZip('not a zip')).toEqual([])
  })

  it('does not classify a whole ZIP prefix from one mapped member', () => {
    // Five-digit keys, not three-digit prefixes: 804xx is Breckenridge AND
    // suburban Boulder, and scoring a Boulder rental as ski would inflate it
    // every day for four and a half months.
    expect(seasonalProfileForZip('80424')).toEqual(['ski'])  // Breckenridge
    expect(seasonalProfileForZip('80301')).toEqual([])       // Boulder
  })
})

describe('resolveSeasonalProfile', () => {
  it('derives from the ZIP when no override is set', () => {
    expect(resolveSeasonalProfile([], '35010')).toEqual(['summer_vacation'])
    expect(resolveSeasonalProfile(null, '80424')).toEqual(['ski'])
    expect(resolveSeasonalProfile(undefined, '37738')).toEqual(['summer_vacation', 'fall_foliage'])
  })

  it('lets a human override win over the derivation', () => {
    expect(resolveSeasonalProfile(['year_round_urban'], '35010')).toEqual(['year_round_urban'])
  })

  it('honours an override of [none], rather than re-deriving over it', () => {
    // The whole reason empty is the unset state: ['none'] chosen by a person
    // and 'nobody has said' must stay distinguishable, or the derivation
    // silently overrules a human every night.
    expect(resolveSeasonalProfile(['none'], '35010')).toEqual(['none'])
    expect(resolveSeasonalProfile([], '35010')).toEqual(['summer_vacation'])
  })

  it('carries a multi-value override through intact', () => {
    expect(resolveSeasonalProfile(['ski', 'fall_foliage'], '78703'))
      .toEqual(['ski', 'fall_foliage'])
  })
})
