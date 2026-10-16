import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FREEZE_THRESHOLD_F, MIN_PROOF_PHOTOS, decideFreezeWatch, effectiveThreshold,
  freezeWorkOrderCopy, parseFreezeThreshold, type FreezeCandidateProperty,
} from '@/lib/evidence/freeze-watch'

const property = (over: Partial<FreezeCandidateProperty> = {}): FreezeCandidateProperty => ({
  id: 'p1', name: 'Lake House', freeze_threshold_f: null, lat: 36.1, lng: -86.7, ...over,
})
const decide = (over: Partial<Parameters<typeof decideFreezeWatch>[0]> = {}) =>
  decideFreezeWatch({ property: property(), forecast: { temperatureMin: 20 }, occupied: false, hasOpenFreezeWo: false, ...over })

describe('effectiveThreshold', () => {
  it('uses the platform default when the property has none', () => {
    expect(effectiveThreshold({ freeze_threshold_f: null })).toBe(DEFAULT_FREEZE_THRESHOLD_F)
    expect(DEFAULT_FREEZE_THRESHOLD_F).toBe(28)
    expect(effectiveThreshold({ freeze_threshold_f: 32 })).toBe(32)
  })
})

describe('decideFreezeWatch', () => {
  it('fires when the low is at or below the threshold on a vacant night', () => {
    expect(decide()).toMatchObject({ fire: true, reason: 'below_threshold', low: 20, threshold: 28 })
    expect(decide({ forecast: { temperatureMin: 28 } }).fire).toBe(true)
  })
  it('does not fire above the threshold', () => {
    expect(decide({ forecast: { temperatureMin: 29 } })).toMatchObject({ fire: false, reason: 'above_threshold' })
  })
  it('does not fire when guests are in the house', () => {
    expect(decide({ occupied: true })).toMatchObject({ fire: false, reason: 'occupied' })
  })
  it('does not stack a second work order while one is open', () => {
    expect(decide({ hasOpenFreezeWo: true })).toMatchObject({ fire: false, reason: 'open_work_order' })
  })
  it('never treats a missing low as zero degrees', () => {
    expect(decide({ forecast: { temperatureMin: null } })).toMatchObject({ fire: false, reason: 'no_forecast' })
    expect(decide({ forecast: null })).toMatchObject({ fire: false, reason: 'no_forecast' })
    expect(decide({ forecast: {} as { temperatureMin: number | null } })).toMatchObject({ fire: false, reason: 'no_forecast' })
  })
  it('does not fire without usable coordinates', () => {
    expect(decide({ property: property({ lat: null }) }).reason).toBe('no_coordinates')
    expect(decide({ property: property({ lat: 0, lng: 0 }) }).reason).toBe('no_coordinates')
  })
  it('respects a per-property threshold', () => {
    expect(decide({ property: property({ freeze_threshold_f: 90 }), forecast: { temperatureMin: 60 } }).fire).toBe(true)
  })
})

describe('freezeWorkOrderCopy', () => {
  const copy = freezeWorkOrderCopy({ propertyName: 'Lake House', forecastDate: '2026-12-01', low: 19.6, threshold: 28 })
  it('names the property, date and rounded low', () => {
    expect(copy.title).toContain('Lake House')
    expect(copy.title).toContain('20°F')
    expect(copy.title).toContain('2026-12-01')
  })
  it('states the photo requirement and contains no em dash', () => {
    expect(copy.description).toContain(`at least ${MIN_PROOF_PHOTOS} photos`)
    expect(copy.title + copy.description).not.toMatch(/—/)
  })
  it('omits the property clause when the name is missing', () => {
    expect(freezeWorkOrderCopy({ propertyName: null, forecastDate: '2026-12-01', low: 10, threshold: 28 }).title)
      .toBe('Freeze prep: forecast low 10°F on 2026-12-01')
  })
})

describe('parseFreezeThreshold', () => {
  it('maps blank to null (platform default)', () => {
    expect(parseFreezeThreshold(null)).toEqual({ value: null })
    expect(parseFreezeThreshold('  ')).toEqual({ value: null })
  })
  it('accepts whole numbers inside the CHECK range, including negatives', () => {
    expect(parseFreezeThreshold('28')).toEqual({ value: 28 })
    expect(parseFreezeThreshold('-20')).toEqual({ value: -20 })
    expect(parseFreezeThreshold('45')).toEqual({ value: 45 })
  })
  it('rejects out of range and non integer input instead of clamping', () => {
    expect('error' in parseFreezeThreshold('46')).toBe(true)
    expect('error' in parseFreezeThreshold('-21')).toBe(true)
    expect('error' in parseFreezeThreshold('28.5')).toBe(true)
    expect('error' in parseFreezeThreshold('abc')).toBe(true)
  })
})
