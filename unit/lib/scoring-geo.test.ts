import { describe, it, expect } from 'vitest'
import { haversineKm, proximityScore, clamp01 } from '@/lib/scoring/geo'

describe('haversineKm', () => {
  it('returns 0 for identical coordinates', () => {
    expect(haversineKm(33.5, -86.5, 33.5, -86.5)).toBe(0)
  })

  it('returns ~111.19 km for 1 degree of longitude at the equator', () => {
    // Independently-known fact: 1 degree of great-circle arc on Earth's mean
    // radius (6371 km) is 2*pi*6371/360 ≈ 111.19 km, regardless of the
    // haversine formula's own internals — a solid external check.
    expect(haversineKm(0, 0, 0, 1)).toBeCloseTo(111.195, 2)
  })

  it('returns the half-circumference for antipodal points', () => {
    // (0,0) and (0,180) are diametrically opposite — the great-circle
    // distance between them is exactly pi * R.
    expect(haversineKm(0, 0, 0, 180)).toBeCloseTo(Math.PI * 6371, 2)
  })

  it('returns ~0 for two different longitudes at the same pole', () => {
    // At the pole, every line of longitude converges to the same point.
    expect(haversineKm(90, 0, 90, 45)).toBeCloseTo(0, 6)
  })

  it('matches the known great-circle distance between New York City and Los Angeles', () => {
    // Published great-circle distance ≈ 3936 km (2445 mi).
    const km = haversineKm(40.7128, -74.0060, 34.0522, -118.2437)
    expect(km).toBeCloseTo(3935.75, 0)
  })

  it('matches the known great-circle distance between New York City and London', () => {
    // Published great-circle distance ≈ 5570 km (3461 mi).
    const km = haversineKm(40.7128, -74.0060, 51.5074, -0.1278)
    expect(km).toBeCloseTo(5570.22, 0)
  })

  it('is symmetric regardless of argument order', () => {
    const a = haversineKm(40.7128, -74.0060, 34.0522, -118.2437)
    const b = haversineKm(34.0522, -118.2437, 40.7128, -74.0060)
    expect(a).toBeCloseTo(b, 8)
  })

  it('handles negative-to-positive longitude crossing correctly', () => {
    // Two points straddling the 0-degree meridian.
    const km = haversineKm(51.5, -1.0, 51.5, 1.0)
    expect(km).toBeGreaterThan(0)
    expect(km).toBeCloseTo(138.44, 1)
  })
})

describe('proximityScore', () => {
  it('scores under 5km at the maximum 1.0', () => {
    expect(proximityScore(0)).toBe(1.0)
    expect(proximityScore(4.99)).toBe(1.0)
  })

  it('scores exactly 5km in the next bucket down (0.8) — upper bound is exclusive', () => {
    expect(proximityScore(5)).toBe(0.8)
  })

  it('scores 5-15km at 0.8', () => {
    expect(proximityScore(14.99)).toBe(0.8)
  })

  it('scores exactly 15km at 0.6 — boundary is exclusive', () => {
    expect(proximityScore(15)).toBe(0.6)
  })

  it('scores 15-30km at 0.6', () => {
    expect(proximityScore(29.99)).toBe(0.6)
  })

  it('scores exactly 30km at 0.4 — boundary is exclusive', () => {
    expect(proximityScore(30)).toBe(0.4)
  })

  it('scores 30-50km at 0.4', () => {
    expect(proximityScore(49.99)).toBe(0.4)
  })

  it('scores exactly 50km at 0.2 — boundary is exclusive', () => {
    expect(proximityScore(50)).toBe(0.2)
  })

  it('scores 50-80km at 0.2', () => {
    expect(proximityScore(79.99)).toBe(0.2)
  })

  it('scores exactly 80km and beyond at 0.0 — boundary is exclusive', () => {
    expect(proximityScore(80)).toBe(0.0)
    expect(proximityScore(1000)).toBe(0.0)
  })
})

describe('clamp01', () => {
  it('passes through values already within [0, 1]', () => {
    expect(clamp01(0)).toBe(0)
    expect(clamp01(0.5)).toBe(0.5)
    expect(clamp01(1)).toBe(1)
  })

  it('clamps values above 1 down to 1', () => {
    expect(clamp01(1.5)).toBe(1)
    expect(clamp01(1000)).toBe(1)
  })

  it('clamps values below 0 up to 0', () => {
    expect(clamp01(-0.5)).toBe(0)
    expect(clamp01(-1000)).toBe(0)
  })
})
