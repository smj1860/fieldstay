import { describe, it, expect } from 'vitest'
import { distanceFeet, formatDistance, GEOFENCE_WARN_FT } from '@/lib/evidence/geo'

describe('distanceFeet', () => {
  it('matches a known pair within 1%', () => {
    // Nashville to Memphis city centers: about 196 statute miles great-circle.
    const ft = distanceFeet({ lat: 36.1627, lng: -86.7816 }, { lat: 35.1495, lng: -90.049 })
    const miles = ft / 5280
    expect(miles).toBeGreaterThan(195 * 0.99)
    expect(miles).toBeLessThan(197 * 1.01)
  })
  it('is zero for the same point and symmetric', () => {
    const a = { lat: 36.1, lng: -86.7 }
    const b = { lat: 36.2, lng: -86.8 }
    expect(distanceFeet(a, a)).toBe(0)
    expect(distanceFeet(a, b)).toBeCloseTo(distanceFeet(b, a), 6)
  })
  it('measures a short walk in feet', () => {
    // 0.001 degree of latitude is about 365 ft.
    const ft = distanceFeet({ lat: 36, lng: -86 }, { lat: 36.001, lng: -86 })
    expect(ft).toBeGreaterThan(360)
    expect(ft).toBeLessThan(370)
  })
})

describe('formatDistance', () => {
  it('prints whole feet under 1,000 and miles with one decimal above', () => {
    expect(formatDistance(850)).toBe('850 ft')
    expect(formatDistance(6900)).toBe('1.3 mi')
    expect(formatDistance(999.6)).toBe('1000 ft')
  })
  it('the default geofence is 1,640 ft', () => { expect(GEOFENCE_WARN_FT).toBe(1640) })
})

import { parseGeofenceRadius } from '@/lib/evidence/geo'
describe('parseGeofenceRadius', () => {
  it('treats blank as the default and bounds the rest', () => {
    expect(parseGeofenceRadius('')).toEqual({ value: null })
    expect(parseGeofenceRadius(null)).toEqual({ value: null })
    expect(parseGeofenceRadius('3000')).toEqual({ value: 3000 })
    expect('error' in parseGeofenceRadius('149')).toBe(true)
    expect('error' in parseGeofenceRadius('16001')).toBe(true)
    expect('error' in parseGeofenceRadius('12.5')).toBe(true)
  })
})
