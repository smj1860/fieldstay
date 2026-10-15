import { describe, it, expect } from 'vitest'
import { isUuid, isSha256, isIsoInstant, isStoragePath, finiteOrNull, latOrNull, lngOrNull } from '@/lib/evidence/validate'

describe('evidence validate', () => {
  it('uuid', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isUuid('nope')).toBe(false)
    expect(isUuid(null)).toBe(false)
  })
  it('sha256', () => {
    expect(isSha256('a'.repeat(64))).toBe(true)
    expect(isSha256('a'.repeat(63))).toBe(false)
    expect(isSha256('g'.repeat(64))).toBe(false)
  })
  it('iso instant', () => {
    expect(isIsoInstant('2026-10-14T10:00:00Z')).toBe(true)
    expect(isIsoInstant('garbage')).toBe(false)
    expect(isIsoInstant(5)).toBe(false)
  })
  it('storage path rejects traversal, empties and oversize', () => {
    expect(isStoragePath('o/a/b.jpg')).toBe(true)
    expect(isStoragePath('o/../b.jpg')).toBe(false)
    expect(isStoragePath('')).toBe(false)
    expect(isStoragePath('x'.repeat(513))).toBe(false)
  })
  it('numbers', () => {
    expect(finiteOrNull(NaN)).toBeNull()
    expect(finiteOrNull(Infinity)).toBeNull()
    expect(finiteOrNull('3')).toBeNull()
    expect(finiteOrNull(3)).toBe(3)
    expect(latOrNull(91)).toBeNull()
    expect(lngOrNull(-181)).toBeNull()
    expect(latOrNull(36.5)).toBe(36.5)
  })
})
