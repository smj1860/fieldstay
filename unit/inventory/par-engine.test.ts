import { describe, it, expect } from 'vitest'
import {
  resolvePar,
  HISTORICAL_FLOOR,
  type ParItemConfig,
  type ParPropertyContext,
  type ParConsumptionStats,
} from '@/lib/inventory/par-engine'

const baseProperty: ParPropertyContext = {
  bathrooms:       2,
  bedrooms:        3,
  max_guests:      6,
  avg_stay_length: 3,
}

const baseConfig: ParItemConfig = {
  par_mode:    'static',
  smart_group: null,
  base_qty:    1,
  par_level:   5,
  auto_adjust: true,
}

describe('resolvePar', () => {
  it('static mode returns stored par_level untouched even with qualifying stats', () => {
    const stats: ParConsumptionStats = { avg_rate_per_guest_night: 0.5, sample_count: 3 }
    const result = resolvePar(baseConfig, baseProperty, stats)
    expect(result).toEqual({ par: 5, source: 'static' })
  })

  it('bathroom_essential formula: ceil(2 × 2.5 × 1.15) = 6', () => {
    const config: ParItemConfig = { ...baseConfig, par_mode: 'smart', smart_group: 'bathroom_essential', base_qty: 2 }
    const property: ParPropertyContext = { ...baseProperty, bathrooms: 2.5 }
    const result = resolvePar(config, property, null)
    expect(result).toEqual({ par: 6, source: 'smart_formula' })
  })

  it('bedroom_essential formula: ceil(4 × 3 × 1.20) = 15', () => {
    const config: ParItemConfig = { ...baseConfig, par_mode: 'smart', smart_group: 'bedroom_essential', base_qty: 4 }
    const property: ParPropertyContext = { ...baseProperty, bedrooms: 3 }
    const result = resolvePar(config, property, null)
    expect(result).toEqual({ par: 15, source: 'smart_formula' })
  })

  it('guest_consumable formula: ceil(1 × 6 × 1.10) = 7', () => {
    const config: ParItemConfig = { ...baseConfig, par_mode: 'smart', smart_group: 'guest_consumable', base_qty: 1 }
    const property: ParPropertyContext = { ...baseProperty, max_guests: 6 }
    const result = resolvePar(config, property, null)
    expect(result).toEqual({ par: 7, source: 'smart_formula' })
  })

  it('null bathrooms degrades to multiplier 1, never 0 or NaN', () => {
    const config: ParItemConfig = { ...baseConfig, par_mode: 'smart', smart_group: 'bathroom_essential', base_qty: 2 }
    const property: ParPropertyContext = { ...baseProperty, bathrooms: null }
    const result = resolvePar(config, property, null)
    expect(result.par).toBe(Math.ceil(2 * 1 * 1.15))
    expect(Number.isNaN(result.par)).toBe(false)
    expect(result.source).toBe('smart_formula')
  })

  it('historical: rate 0.5, sample_count 3, max_guests 6, avg_stay_length 3 → ceil(0.5 × 6 × 3 × 1.20) = 11', () => {
    const config: ParItemConfig = { ...baseConfig, par_mode: 'smart', smart_group: 'guest_consumable', base_qty: 1 }
    const stats: ParConsumptionStats = { avg_rate_per_guest_night: 0.5, sample_count: 3 }
    const result = resolvePar(config, baseProperty, stats)
    expect(result).toEqual({ par: 11, source: 'historical' })
  })

  it('historical floor: a tiny rate resolves to HISTORICAL_FLOOR', () => {
    const config: ParItemConfig = { ...baseConfig, par_mode: 'smart', smart_group: 'guest_consumable', base_qty: 1 }
    const stats: ParConsumptionStats = { avg_rate_per_guest_night: 0.001, sample_count: 3 }
    const result = resolvePar(config, baseProperty, stats)
    expect(result).toEqual({ par: HISTORICAL_FLOOR, source: 'historical' })
  })

  it('sample_count below threshold falls back to smart_formula', () => {
    const config: ParItemConfig = { ...baseConfig, par_mode: 'smart', smart_group: 'guest_consumable', base_qty: 1 }
    const stats: ParConsumptionStats = { avg_rate_per_guest_night: 0.5, sample_count: 2 }
    const result = resolvePar(config, baseProperty, stats)
    expect(result.source).toBe('smart_formula')
  })

  it('auto_adjust: false with qualifying stats falls back to smart_formula (the pin works)', () => {
    const config: ParItemConfig = {
      ...baseConfig,
      par_mode:    'smart',
      smart_group: 'guest_consumable',
      base_qty:    1,
      auto_adjust: false,
    }
    const stats: ParConsumptionStats = { avg_rate_per_guest_night: 0.5, sample_count: 3 }
    const result = resolvePar(config, baseProperty, stats)
    expect(result.source).toBe('smart_formula')
  })

  it('smart mode with smart_group null (defensive) returns >= 1 and does not throw', () => {
    const config: ParItemConfig = { ...baseConfig, par_mode: 'smart', smart_group: null, par_level: 3 }
    expect(() => resolvePar(config, baseProperty, null)).not.toThrow()
    const result = resolvePar(config, baseProperty, null)
    expect(result.par).toBeGreaterThanOrEqual(1)
  })
})
