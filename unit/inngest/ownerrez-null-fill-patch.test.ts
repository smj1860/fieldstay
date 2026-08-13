import { describe, it, expect } from 'vitest'

// No mocks: buildNullFillPatch is pure and imports nothing at runtime.
import { buildNullFillPatch } from '@/lib/inngest/functions/ownerrez/initial-sync'

// ============================================================================
// The NULL-fill rule for OwnerRez property data, extracted from
// patch-property-fields so the decision is testable without driving the whole
// Inngest step.
//
// The load-bearing detail is `!== null` rather than a falsy check. A falsy
// check also matches a legitimate 0 — a studio's bedroom count, a property
// with no recorded square footage — and would overwrite a PM's manual
// correction with whatever OwnerRez reports, on EVERY re-run of this step.
// The suite in ownerrez-initial-sync.test.ts already guards that end to end;
// these cover each field and each direction directly.
// ============================================================================

const OR = (over: Partial<{ bedrooms: number | null; bathrooms: number | null; sqft: number | null }> = {}) =>
  ({ bedrooms: 3, bathrooms: 2, sqft: 1800, ...over })

const FS = (over: Partial<{ bedrooms: number | null; bathrooms: number | null; square_footage: number | null }> = {}) =>
  ({ bedrooms: null, bathrooms: null, square_footage: null, ...over })

describe('buildNullFillPatch', () => {
  it('fills every field FieldStay holds as null', () => {
    expect(buildNullFillPatch(OR(), FS())).toEqual({
      bedrooms: 3, bathrooms: 2, square_footage: 1800,
    })
  })

  it('NEVER overwrites a legitimate 0 — the regression this rule exists for', () => {
    // A studio really does have 0 bedrooms. A falsy check would treat that as
    // "unset" and overwrite the PM's value on every sync.
    const patch = buildNullFillPatch(OR(), FS({ bedrooms: 0, bathrooms: 0, square_footage: 0 }))
    expect(patch).toEqual({})
  })

  it('never overwrites a non-null PM value', () => {
    const patch = buildNullFillPatch(OR(), FS({ bedrooms: 9, bathrooms: 9, square_footage: 9 }))
    expect(patch).toEqual({})
  })

  it('skips a field OwnerRez itself has no value for', () => {
    const patch = buildNullFillPatch(OR({ bedrooms: null, sqft: null }), FS())
    expect(patch).toEqual({ bathrooms: 2 })
    expect('bedrooms' in patch).toBe(false)
    expect('square_footage' in patch).toBe(false)
  })

  it('fills each field independently — one null does not block the others', () => {
    const patch = buildNullFillPatch(OR(), FS({ bedrooms: 4 }))
    expect(patch).toEqual({ bathrooms: 2, square_footage: 1800 })
  })

  it('accepts a real 0 FROM OwnerRez when FieldStay is null', () => {
    // The mirror of the regression above: 0 is a legitimate value on both
    // sides, so a falsy check would also wrongly SKIP writing it.
    const patch = buildNullFillPatch(OR({ bedrooms: 0, bathrooms: 0, sqft: 0 }), FS())
    expect(patch).toEqual({ bedrooms: 0, bathrooms: 0, square_footage: 0 })
  })

  it('returns an empty object rather than undefined when nothing applies', () => {
    // The caller gates the UPDATE on Object.keys(patch).length, so the shape
    // matters: undefined would throw there.
    expect(buildNullFillPatch(OR({ bedrooms: null, bathrooms: null, sqft: null }), FS())).toEqual({})
  })
})
