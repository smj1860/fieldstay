import { describe, it, expect } from 'vitest'
import {
  WIZARD_STEPS,
  getStepIndex,
  getNextStep,
  getPrevStep,
  calcSetupProgress,
  firstIncompleteStep,
  type WizardStepKey,
} from '@/lib/wizard'

describe('getStepIndex', () => {
  it('returns the correct index for each declared step', () => {
    WIZARD_STEPS.forEach((step, idx) => {
      expect(getStepIndex(step.key)).toBe(idx)
    })
  })
})

describe('getNextStep', () => {
  it('returns the following step key for a non-final step', () => {
    expect(getNextStep('details')).toBe('ical')
    expect(getNextStep('ical')).toBe('inventory')
  })

  it('returns null for the final step', () => {
    const lastKey = WIZARD_STEPS[WIZARD_STEPS.length - 1].key
    expect(getNextStep(lastKey)).toBeNull()
  })
})

describe('getPrevStep', () => {
  it('returns the preceding step key for a non-first step', () => {
    expect(getPrevStep('ical')).toBe('details')
    expect(getPrevStep('checklist')).toBe('inventory')
  })

  it('returns null for the first step', () => {
    const firstKey = WIZARD_STEPS[0].key
    expect(getPrevStep(firstKey)).toBeNull()
  })
})

describe('calcSetupProgress', () => {
  it('returns 0 when nothing is complete', () => {
    expect(calcSetupProgress({})).toBe(0)
  })

  it('returns 100 when every step is complete', () => {
    const completed: Record<string, boolean> = {}
    for (const step of WIZARD_STEPS) completed[step.key] = true
    expect(calcSetupProgress(completed)).toBe(100)
  })

  it('rounds a partial completion to the nearest whole percent', () => {
    // 1 of 5 steps complete = 20%
    expect(calcSetupProgress({ details: true })).toBe(20)
    // 2 of 5 steps complete = 40%
    expect(calcSetupProgress({ details: true, ical: true })).toBe(40)
  })

  it('ignores keys that are not real step keys', () => {
    expect(calcSetupProgress({ details: true, not_a_real_step: true })).toBe(20)
  })

  it('ignores falsy entries', () => {
    expect(calcSetupProgress({ details: true, ical: false })).toBe(20)
  })
})

describe('firstIncompleteStep', () => {
  it('returns the first step key when nothing is complete', () => {
    expect(firstIncompleteStep({})).toBe(WIZARD_STEPS[0].key)
  })

  it('returns the first step that is not yet marked complete, in declared order', () => {
    expect(firstIncompleteStep({ details: true, ical: true })).toBe('inventory')
  })

  it('skips a gap where a later step is complete but an earlier one is not', () => {
    // "checklist" complete but "inventory" is not — inventory comes first in order
    expect(firstIncompleteStep({ details: true, ical: true, checklist: true })).toBe('inventory')
  })

  it('falls back to the first step key when every step is complete', () => {
    const completed: Record<string, boolean> = {}
    for (const step of WIZARD_STEPS) completed[step.key] = true
    expect(firstIncompleteStep(completed)).toBe(WIZARD_STEPS[0].key)
  })
})

describe('WIZARD_STEPS', () => {
  it('has unique step keys', () => {
    const keys = WIZARD_STEPS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('type WizardStepKey matches every declared step key', () => {
    const keys: WizardStepKey[] = WIZARD_STEPS.map((s) => s.key)
    expect(keys.length).toBe(WIZARD_STEPS.length)
  })
})
