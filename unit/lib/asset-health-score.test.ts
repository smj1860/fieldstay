import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  calculateHealthScore,
  weibullSurvivalFraction,
  healthLabel,
  healthColor,
  healthDot,
  healthBgStyle,
  type AssetRepairSummary,
} from '@/lib/assets/health-score'

const NOW = new Date('2026-07-22T12:00:00.000Z')

const standards = {
  lifespan_min_years:        10,
  lifespan_max_years:        15,
  avg_replacement_cost_high: 4000,
}

const noRepairs: AssetRepairSummary = {
  total_repairs:     0,
  total_repair_cost: 0,
  last_serviced_at:  null,
}

describe('calculateHealthScore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the neutral default of 50 when installation_date is missing', () => {
    const score = calculateHealthScore(
      { installation_date: null,
      manufacture_date: null, expected_lifespan_years: 10, estimated_replacement_cost: 1000 },
      standards,
      noRepairs,
    )
    expect(score).toBe(50)
  })

  it('scores from the nameplate manufacture year rather than defaulting to 50', () => {
    // The scanned-asset case. FieldStay read a real year off the data plate;
    // returning the neutral 50 meant the asset could never be flagged.
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const score = calculateHealthScore(
      {
        installation_date:          null,
        manufacture_date:           '2006-01-01',
        expected_lifespan_years:    10,
        estimated_replacement_cost: 1000,
      },
      standards,
      noRepairs,
    )
    // 20 years against a 10-year lifespan — well past end of life, and nothing
    // like the flat 50 an undated asset gets.
    expect(score).toBeLessThan(50)
  })

  it('still prefers a recorded installation date over the nameplate year', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const common = { expected_lifespan_years: 10, estimated_replacement_cost: 1000 }
    const recorded = calculateHealthScore(
      { installation_date: '2026-07-22', manufacture_date: '2006-01-01', ...common },
      standards, noRepairs,
    )
    const nameplateOnly = calculateHealthScore(
      { installation_date: null, manufacture_date: '2006-01-01', ...common },
      standards, noRepairs,
    )
    expect(recorded).toBeGreaterThan(nameplateOnly)
  })

  it('scores a brand-new asset (zero age, no repairs) at 100', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2026-07-22',
      manufacture_date:          null,
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    const score = calculateHealthScore(asset, standards, noRepairs)
    // ageYears = 0 -> Weibull survival = 1 -> ageScore = weights.age (60)
    // conditionScore = weights.condition (40) - 0 - 0 + 0 (no recency bonus, never serviced)
    expect(score).toBe(100)
  })

  it('drives age contribution toward 0 for an asset well past its full expected lifespan', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2006-07-22',
      manufacture_date:          null, // 20 years old
      expected_lifespan_years:    10,            // well past lifespan
      estimated_replacement_cost: 1000,
    }
    const score = calculateHealthScore(asset, standards, noRepairs)
    // t/eta = 2.0 -> Weibull survival ~0.35% -> ageScore rounds to 0.
    // conditionScore = 40 (no repairs).
    expect(score).toBe(40)
  })

  it('falls back to the standard lifespan midpoint when expected_lifespan_years is null', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2020-07-22',
      manufacture_date:          null, // 6 years old
      expected_lifespan_years:    null,
      estimated_replacement_cost: 1000,
    }
    // midpoint of 10-15 = 12.5 -> rounds to 13 (Math.round(12.5) = 13)
    const score = calculateHealthScore(asset, standards, noRepairs)
    const lifespan = Math.round((10 + 15) / 2) // 13
    const ageScore = Math.round(weibullSurvivalFraction(6, lifespan) * 60)
    expect(score).toBe(ageScore + 40)
  })

  it('guards against a 0/0 standard range by falling back to a 10-year lifespan', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2021-07-22',
      manufacture_date:          null, // 5 years old
      expected_lifespan_years:    null,
      estimated_replacement_cost: 1000,
    }
    const zeroStandards = { lifespan_min_years: 0, lifespan_max_years: 0, avg_replacement_cost_high: 4000 }
    const score = calculateHealthScore(asset, zeroStandards, noRepairs)
    // lifespan falls back to 10 -> t/eta = 0.5 -> Weibull survival ~83.8% -> ageScore = round(0.8380 * 60) = 50
    expect(score).toBe(50 + 40)
  })

  it('applies a repair-frequency penalty proportional to repairs per year', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2024-07-22',
      manufacture_date:          null, // 2 years old
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    const repairs: AssetRepairSummary = {
      total_repairs:     4, // 2/year
      total_repair_cost: 0,
      last_serviced_at:  null,
    }
    const score = calculateHealthScore(asset, standards, repairs)
    // ageYears=2, t/eta=0.2 -> Weibull survival ~98.2% -> ageScore=round(0.9823*60)=59
    // repairsPerYear = 2 -> repairFreqPenalty = min(20, round(20)) = 20
    // repairCostPenalty = 0
    // conditionScore = max(0, 40 - 20 - 0 + 0) = 20
    expect(score).toBe(59 + 20)
  })

  it('caps the repair-frequency penalty at 0.5 * weights.condition even with very high repair frequency', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2025-07-22',
      manufacture_date:          null, // 1 year old
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    const repairs: AssetRepairSummary = {
      total_repairs:     50, // 50/year -> would be round(500) uncapped
      total_repair_cost: 0,
      last_serviced_at:  null,
    }
    const score = calculateHealthScore(asset, standards, repairs)
    // ageYears=1, t/eta=0.1 -> Weibull survival ~99.7% -> ageScore=round(0.9968*60)=60
    // repairFreqPenalty capped at 0.5*40=20
    // conditionScore = max(0, 40-20-0+0)=20
    expect(score).toBe(60 + 20)
  })

  it('applies a repair-cost penalty proportional to cost as a fraction of replacement cost', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2024-07-22',
      manufacture_date:          null, // 2 years old
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    const repairs: AssetRepairSummary = {
      total_repairs:     0,
      total_repair_cost: 100, // 10% of replacement cost
      last_serviced_at:  null,
    }
    const score = calculateHealthScore(asset, standards, repairs)
    // ageScore = 59 (2 years old, as above)
    // repairsPerYear=0 -> repairFreqPenalty=0
    // repairCostPct = 100/1000 = 0.1 -> repairCostPenalty = min(15, round(10)) = 10
    // conditionScore = max(0, 40-0-10+0)=30
    expect(score).toBe(59 + 30)
  })

  it('caps the repair-cost penalty at 0.375 * weights.condition even with cost exceeding replacement value', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2024-07-22',
      manufacture_date:          null, // 2 years old
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    const repairs: AssetRepairSummary = {
      total_repairs:     0,
      total_repair_cost: 5000, // 500% of replacement cost
      last_serviced_at:  null,
    }
    const score = calculateHealthScore(asset, standards, repairs)
    // ageScore = 59 (2 years old)
    // repairCostPenalty capped at 0.375*40=15
    // conditionScore = max(0, 40-0-15+0)=25
    expect(score).toBe(59 + 25)
  })

  it('falls back to a $5000 replacement cost when both asset and standard costs are missing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2024-07-22',
      manufacture_date:          null,
      expected_lifespan_years:    10,
      estimated_replacement_cost: null,
    }
    const noCostStandards = { lifespan_min_years: 10, lifespan_max_years: 15, avg_replacement_cost_high: null }
    const repairs: AssetRepairSummary = { total_repairs: 0, total_repair_cost: 500, last_serviced_at: null }
    const score = calculateHealthScore(asset, noCostStandards, repairs)
    // repairCostPct = 500/5000 = 0.1 -> repairCostPenalty = min(15, round(10))=10
    // ageScore=59 (2 years old), conditionScore=max(0,40-0-10+0)=30
    expect(score).toBe(59 + 30)
  })

  it('awards a +5 recency bonus when serviced within the last 6 months', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2024-07-22',
      manufacture_date:          null, // 2 years old
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    const repairs: AssetRepairSummary = {
      total_repairs:     0,
      total_repair_cost: 0,
      last_serviced_at:  '2026-06-01', // ~1.7 months ago
    }
    const score = calculateHealthScore(asset, standards, repairs)
    // ageScore=59, conditionScore = max(0, 40-0-0+5) = 45 -> 59+45=104, capped at 100 overall (not per-component)
    expect(score).toBe(100)
  })

  it('awards a +2 recency bonus when serviced 6-12 months ago', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2024-07-22',
      manufacture_date:          null,
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    const repairs: AssetRepairSummary = {
      total_repairs:     0,
      total_repair_cost: 0,
      last_serviced_at:  '2026-01-10', // ~6.4 months ago
    }
    const score = calculateHealthScore(asset, standards, repairs)
    // ageScore=59, conditionScore=42 -> 59+42=101, capped at 100 overall
    expect(score).toBe(100)
  })

  it('awards no recency bonus when serviced more than 12 months ago', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2024-07-22',
      manufacture_date:          null,
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    const repairs: AssetRepairSummary = {
      total_repairs:     0,
      total_repair_cost: 0,
      last_serviced_at:  '2024-01-01', // well over a year ago
    }
    const score = calculateHealthScore(asset, standards, repairs)
    // ageScore=59, conditionScore=40 (no bonus)
    expect(score).toBe(59 + 40)
  })

  it('awards no recency bonus when never serviced (null last_serviced_at treated as overdue)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2024-07-22',
      manufacture_date:          null,
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    const score = calculateHealthScore(asset, standards, noRepairs)
    // ageScore=59, conditionScore=40 (never serviced treated as overdue -> no bonus)
    expect(score).toBe(59 + 40)
  })

  it('floors at the minimum permitted score for an asset past its max lifespan with extreme repair history', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2000-07-22',
      manufacture_date:          null, // very old, past lifespan
      expected_lifespan_years:    5,
      estimated_replacement_cost: 100,
    }
    const repairs: AssetRepairSummary = {
      total_repairs:     1000,
      total_repair_cost: 1_000_000,
      last_serviced_at:  null,
    }
    const score = calculateHealthScore(asset, standards, repairs)
    // ageScore = 0 (agePct clamped to 1.0).
    // repairFreqPenalty and repairCostPenalty are both proportional caps
    // (0.5 * weights.condition and 0.375 * weights.condition), so together
    // they can never fully exhaust weights.condition — the mathematical
    // floor at default weights is weights.condition * 0.125 = 5, not 0.
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBe(5)
  })

  it('never returns a score above 100', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2026-07-22',
      manufacture_date:          null, // zero age
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    const repairs: AssetRepairSummary = {
      total_repairs:     0,
      total_repair_cost: 0,
      last_serviced_at:  '2026-07-01', // <6mo -> +5 bonus
    }
    const score = calculateHealthScore(asset, standards, repairs)
    expect(score).toBeLessThanOrEqual(100)
    expect(score).toBe(100)
  })

  it('respects custom scoring weights', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2026-07-22',
      manufacture_date:          null, // zero age
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    const score = calculateHealthScore(asset, standards, noRepairs, { age: 70, condition: 30 })
    // ageScore = round((1-0)*70) = 70, conditionScore = 30 - 0 - 0 + 0 = 30
    expect(score).toBe(100)
  })

  it('prefers a learned per-type weibull_shape over the shared default when present', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    // Past its expected lifespan (t/eta = 1.5): a steeper learned shape falls
    // off the "cliff" harder here. Below the characteristic life a steeper
    // shape actually holds HIGHER (decays slower) — the direction flips at
    // t = eta, which is the entire point of the curve — so this asset must be
    // past its lifespan for "steeper => lower score" to hold.
    const asset = {
      installation_date:          '2011-07-22',
      manufacture_date:          null, // 15 years old
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    const defaultScore = calculateHealthScore(asset, { ...standards, weibull_shape: null }, noRepairs)
    const learnedScore = calculateHealthScore(asset, { ...standards, weibull_shape: 6 }, noRepairs)
    expect(learnedScore).toBeLessThan(defaultScore)
  })

  it('falls back to the shared default when weibull_shape is absent from standards entirely', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const asset = {
      installation_date:          '2021-07-22',
      manufacture_date:          null,
      expected_lifespan_years:    10,
      estimated_replacement_cost: 1000,
    }
    // `standards` here has no weibull_shape key at all — existing callers that
    // never learned to pass it must keep working exactly as before.
    const score = calculateHealthScore(asset, standards, noRepairs)
    expect(score).toBe(50 + 40) // matches the "guards against a 0/0 standard range" case's t=5,eta=10 age score
  })
})

describe('weibullSurvivalFraction', () => {
  it('is 1 at age 0 (as-new)', () => {
    expect(weibullSurvivalFraction(0, 10)).toBe(1)
  })

  it('sits at e^-1 (~36.8%) at the characteristic life, by definition', () => {
    expect(weibullSurvivalFraction(10, 10)).toBeCloseTo(Math.exp(-1), 6)
  })

  it('ages slower than a linear model through the first half of expected life', () => {
    // A linear 1 - t/eta model would put half-life remaining value at exactly
    // 0.5. The Weibull curve (kappa > 1) stays well above that at the
    // midpoint — this is the "ages slowly at first" behavior the curve
    // exists to model.
    expect(weibullSurvivalFraction(5, 10)).toBeGreaterThan(0.5)
  })

  it('falls off faster than a linear model past expected life (the "cliff")', () => {
    // A linear model floors at exactly 0 the moment age reaches eta and stays
    // there. The Weibull curve keeps falling past that point instead of
    // going flat, and does so steeply — well below what linear decay alone
    // would predict for the same overshoot.
    const atLifespan     = weibullSurvivalFraction(10, 10)
    const pastLifespan   = weibullSurvivalFraction(15, 10)
    expect(pastLifespan).toBeLessThan(atLifespan * 0.2)
  })

  it('returns 0 for a non-positive characteristic life instead of dividing by zero', () => {
    expect(weibullSurvivalFraction(5, 0)).toBe(0)
  })
})

describe('healthLabel', () => {
  it('maps score bands to the correct display label', () => {
    expect(healthLabel(100)).toBe('Good')
    expect(healthLabel(80)).toBe('Good')
    expect(healthLabel(79)).toBe('Fair')
    expect(healthLabel(60)).toBe('Fair')
    expect(healthLabel(59)).toBe('Aging')
    expect(healthLabel(40)).toBe('Aging')
    expect(healthLabel(39)).toBe('Poor')
    expect(healthLabel(20)).toBe('Poor')
    expect(healthLabel(19)).toBe('End of Life')
    expect(healthLabel(0)).toBe('End of Life')
  })
})

describe('healthColor', () => {
  it('maps score bands to the correct CSS variable', () => {
    expect(healthColor(80)).toBe('var(--accent-green)')
    expect(healthColor(60)).toBe('var(--accent-gold)')
    expect(healthColor(40)).toBe('var(--accent-amber)')
    expect(healthColor(20)).toBe('var(--accent-red)')
    expect(healthColor(19)).toBe('var(--text-muted)')
  })
})

describe('healthDot', () => {
  it('maps score bands to the correct internal StatusDot key', () => {
    expect(healthDot(80)).toBe('good')
    expect(healthDot(60)).toBe('warning')
    expect(healthDot(40)).toBe('attention')
    expect(healthDot(20)).toBe('critical')
    expect(healthDot(19)).toBe('offline')
  })
})

describe('healthBgStyle', () => {
  it('maps score bands to the correct background style', () => {
    expect(healthBgStyle(80)).toBe('var(--accent-green-dim, rgba(34,197,94,0.1))')
    expect(healthBgStyle(60)).toBe('var(--accent-gold-dim,  rgba(250,189,0,0.1))')
    expect(healthBgStyle(40)).toBe('var(--accent-amber-dim, rgba(245,158,11,0.1))')
    expect(healthBgStyle(20)).toBe('var(--accent-red-dim,   rgba(240,84,84,0.1))')
    expect(healthBgStyle(19)).toBe('var(--border)')
  })
})
