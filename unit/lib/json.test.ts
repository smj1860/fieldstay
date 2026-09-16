import { describe, it, expect, vi } from 'vitest'
import { asBooleanMap, asJsonObject } from '@/lib/json'

// ============================================================================
// A jsonb column holds whatever was last written to it. A legacy import that
// wrote `{"pool": "yes"}` instead of `{"pool": true}` used to be silently
// dropped by asBooleanMap with nothing distinguishing "this flag is false"
// from "this flag's stored value is garbage" — both rendered as simply absent.
// ============================================================================

describe('asJsonObject', () => {
  it('returns null for a scalar or array, not an object', () => {
    expect(asJsonObject('a string')).toBeNull()
    expect(asJsonObject(42)).toBeNull()
    expect(asJsonObject([1, 2])).toBeNull()
    expect(asJsonObject(null)).toBeNull()
    expect(asJsonObject(undefined)).toBeNull()
  })

  it('returns the object as-is for a real object', () => {
    expect(asJsonObject({ pool: true })).toEqual({ pool: true })
  })
})

describe('asBooleanMap', () => {
  it('keeps only boolean-valued entries', () => {
    expect(asBooleanMap({ pool: true, hot_tub: false })).toEqual({ pool: true, hot_tub: false })
  })

  it('drops a non-boolean entry silently when no ctx is given', () => {
    expect(asBooleanMap({ pool: 'yes' })).toEqual({})
  })

  it('warns at the call site when ctx is given and a value is not a boolean', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = asBooleanMap({ pool: 'yes' }, { site: 'test.asBooleanMap' })

    expect(result).toEqual({})
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('pool')
    expect(warnSpy.mock.calls[0][0]).toContain('test.asBooleanMap')
    warnSpy.mockRestore()
  })

  it('does not warn for an entry that is genuinely undefined', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    asBooleanMap({ pool: undefined }, { site: 'test.asBooleanMap' })

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns {} for null/undefined input', () => {
    expect(asBooleanMap(null)).toEqual({})
    expect(asBooleanMap(undefined)).toEqual({})
  })
})
