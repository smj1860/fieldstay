import { describe, it, expect } from 'vitest'
import { buildRulesSummaryLines } from '@/lib/guidebook/sync'

describe('buildRulesSummaryLines', () => {
  it('renders a line for each non-null rule, allowed and not allowed', () => {
    expect(buildRulesSummaryLines({
      smoking_allowed: false,
      pets_allowed:    true,
      events_allowed:  false,
    })).toEqual([
      'No smoking.',
      'Pets are allowed.',
      'No events or parties.',
    ])
  })

  it('omits a rule entirely when its value is null (unconfirmed/not returned)', () => {
    expect(buildRulesSummaryLines({
      smoking_allowed: null,
      pets_allowed:    true,
      events_allowed:  null,
    })).toEqual(['Pets are allowed.'])
  })

  it('returns an empty array when every rule is null', () => {
    expect(buildRulesSummaryLines({
      smoking_allowed: null,
      pets_allowed:    null,
      events_allowed:  null,
    })).toEqual([])
  })

  it('renders all three as allowed', () => {
    expect(buildRulesSummaryLines({
      smoking_allowed: true,
      pets_allowed:    true,
      events_allowed:  true,
    })).toEqual([
      'Smoking is allowed.',
      'Pets are allowed.',
      'Events/parties are allowed.',
    ])
  })
})
