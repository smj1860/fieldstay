import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { ROOT, readCode } from './scan'

// ============================================================================
// The localEvents seam.
//
// pre_flight_friction.score_breakdown must carry EVERY FrictionComponents key
// on every row — including `localEvents`, which has no scorer and is always 0.
//
// Why that matters enough to gate: the key is what a future local-events
// scorer plugs into, and it is what keeps "this row was scored and local
// events contributed nothing" distinguishable from "this row predates the
// scorer" in stored history. Drop it while it is zero and the whole stored
// series becomes ambiguous retroactively, with nothing to recover it from.
//
// readCode(), not read(): a scanner over raw source reads the comments too,
// and this file's own prose mentions `localEvents: 0` several times.
// ============================================================================

const FRICTION_LIB = join(ROOT, 'lib', 'scoring', 'friction.ts')
const FRICTION_CRON = join(ROOT, 'lib', 'inngest', 'functions', 'cron', 'pre-flight-friction.ts')

/** The declared keys of the FrictionComponents interface. */
function componentKeys(): string[] {
  const code  = readCode(FRICTION_LIB)
  const start = code.indexOf('export interface FrictionComponents {')
  expect(start, 'FrictionComponents interface not found — has it been renamed?').toBeGreaterThan(-1)
  const body = code.slice(start, code.indexOf('}', start))
  return [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!)
}

describe('guardrail: friction localEvents seam', () => {
  it('FrictionComponents still declares localEvents', () => {
    expect(componentKeys()).toContain('localEvents')
  })

  it('the cron assigns localEvents: 0 unconditionally', () => {
    const code = readCode(FRICTION_CRON)
    const assignments = [...code.matchAll(/localEvents:\s*([^,\n]+)/g)].map((m) => m[1]!.trim())

    expect(assignments, 'the cron no longer assigns localEvents at all').not.toEqual([])
    for (const value of assignments) {
      // A literal 0. A ternary, a `?.`, a spread or a variable would all mean
      // the key can be absent or non-zero for some rows, which is the exact
      // thing this guards.
      expect(value, `localEvents must be a literal 0, found: ${value}`).toBe('0')
    }
  })

  it('the stored breakdown is the whole components object, not a picked subset', () => {
    const code = readCode(FRICTION_CRON)
    // Spreading `components` is what makes "every key" structural rather than
    // a list someone has to remember to extend.
    expect(code).toMatch(/score_breakdown:\s*\{\s*\.\.\.components\s*\}/)
  })

  it('every component key has a dashboard label, so none can render as a raw key', () => {
    const code   = readCode(FRICTION_LIB)
    const start  = code.indexOf('const COMPONENT_LABELS')
    expect(start).toBeGreaterThan(-1)
    const body   = code.slice(start, code.indexOf('}', start))
    const labelled = [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!)

    expect(labelled.sort()).toEqual(componentKeys().sort())
  })
})
