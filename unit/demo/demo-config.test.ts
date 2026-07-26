import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { demoSecretMatches, isDemoSurfaceEnabled, DEMO_SECRET_MIN_LENGTH } from '@/lib/demo/config'

// The /demo/* secret gate is the ONLY thing standing between the open
// internet and (a) a minted session as the demo PM and (b) a wipe of the demo
// org. Its failure modes are all silent, so they get explicit coverage.

const ORIGINAL = process.env.DEMO_ENTRY_SECRET

describe('demoSecretMatches', () => {
  beforeEach(() => { process.env.DEMO_ENTRY_SECRET = 'a'.repeat(DEMO_SECRET_MIN_LENGTH) })
  afterEach(()  => {
    if (ORIGINAL === undefined) delete process.env.DEMO_ENTRY_SECRET
    else process.env.DEMO_ENTRY_SECRET = ORIGINAL
  })

  it('accepts the exact secret', () => {
    expect(demoSecretMatches('a'.repeat(DEMO_SECRET_MIN_LENGTH))).toBe(true)
  })

  it('rejects a wrong secret of the same length', () => {
    expect(demoSecretMatches('b'.repeat(DEMO_SECRET_MIN_LENGTH))).toBe(false)
  })

  it('rejects a prefix of the real secret', () => {
    expect(demoSecretMatches('a'.repeat(DEMO_SECRET_MIN_LENGTH - 1))).toBe(false)
  })

  it('rejects a longer string that starts with the real secret', () => {
    // Guards the length-mismatch throw: hashing both sides means differing
    // lengths compare cleanly instead of raising out of timingSafeEqual.
    expect(demoSecretMatches(`${'a'.repeat(DEMO_SECRET_MIN_LENGTH)}extra`)).toBe(false)
  })

  it.each([
    ['null',      null],
    ['undefined', undefined],
    ['empty',     ''],
  ])('rejects %s', (_label, value) => {
    expect(demoSecretMatches(value)).toBe(false)
  })

  it('fails closed when DEMO_ENTRY_SECRET is unset — no key must not mean access', () => {
    delete process.env.DEMO_ENTRY_SECRET
    expect(demoSecretMatches('')).toBe(false)
    expect(demoSecretMatches(null)).toBe(false)
    expect(demoSecretMatches('anything')).toBe(false)
    expect(isDemoSurfaceEnabled()).toBe(false)
  })

  it('fails closed when DEMO_ENTRY_SECRET is the empty string', () => {
    process.env.DEMO_ENTRY_SECRET = ''
    expect(demoSecretMatches('')).toBe(false)
    expect(isDemoSurfaceEnabled()).toBe(false)
  })
})
