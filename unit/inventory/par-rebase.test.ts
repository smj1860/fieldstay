import { describe, it, expect } from 'vitest'
import {
  rebaseParFromTarget,
  resolvePar,
  smartScaleFactor,
  PAR_SMART_GROUPS,
  type ParPropertyContext,
  type ParSmartGroup,
} from '@/lib/inventory/par-engine'

// ============================================================================
// A PM typing a par level on a SMART item.
//
// Before this existed the inline editor wrote par_level directly and the next
// recompute overwrote it, because on a smart item par_level is a cache of
// resolvePar() — the number survived until the next property edit or
// consumption sample, silently, on 267 live items. Re-basing inverts the
// formula so the typed number is exact now AND keeps scaling later.
//
// The load-bearing property is the ROUND TRIP: whatever base_qty comes out
// must feed back through resolvePar() and reproduce the number the PM typed.
// Everything else here is a corollary of that.
// ============================================================================

const prop = (over: Partial<ParPropertyContext> = {}): ParPropertyContext => ({
  bedrooms: 3, bathrooms: 2, max_guests: 8, avg_stay_length: null, ...over,
})

const asItem = (smart_group: ParSmartGroup | null, base_qty: number, par_level: number) => ({
  par_mode: 'smart' as const, smart_group, base_qty, par_level, auto_adjust: false,
})

const GROUPS = Object.keys(PAR_SMART_GROUPS) as ParSmartGroup[]

describe('rebaseParFromTarget', () => {
  it('round-trips EVERY reachable target back to the PM\'s exact number', () => {
    // The exhaustive version of the one guarantee that matters. The naive
    // inverse (target / k) passes a hand-picked example and fails 1337 of
    // these 8400 — 11 / 1.15 * 1.15 is 11.000000000000002, which ceils to 12.
    const misses: string[] = []
    for (const group of GROUPS) {
      for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 14, 16, 21]) {
        const p = prop({ bathrooms: m, bedrooms: m, max_guests: m })
        for (let target = 1; target <= 200; target++) {
          const r   = rebaseParFromTarget(target, { smart_group: group }, p)
          const got = resolvePar(asItem(group, r.base_qty, r.par_level), p, null).par
          if (got !== target) misses.push(`${group} m=${m} target=${target} -> ${got}`)
        }
      }
    }
    expect(misses).toEqual([])
  })

  it('keeps scaling from the PM\'s number when the property changes', () => {
    // The whole point of re-basing rather than pinning. Washcloths at Majestic
    // Shores: base 5, 2 bathrooms -> 12. The PM wants 16.
    const at = (baths: number) => prop({ bathrooms: baths })
    expect(resolvePar(asItem('bathroom_essential', 5, 0), at(2), null).par).toBe(12)

    const r = rebaseParFromTarget(16, { smart_group: 'bathroom_essential' }, at(2))
    expect(r.par_mode).toBe('smart')
    expect(resolvePar(asItem('bathroom_essential', r.base_qty, r.par_level), at(2), null).par).toBe(16)
    // Proportional to their 16, not to the original 5.
    expect(resolvePar(asItem('bathroom_essential', r.base_qty, r.par_level), at(1), null).par).toBe(8)
    expect(resolvePar(asItem('bathroom_essential', r.base_qty, r.par_level), at(3), null).par).toBe(24)
    expect(resolvePar(asItem('bathroom_essential', r.base_qty, r.par_level), at(4), null).par).toBe(31)
  })

  it('turns auto_adjust OFF so learned consumption cannot silently supersede it', () => {
    // historicalPar ignores base_qty entirely. Leaving auto_adjust on would let
    // history override the number the PM just explicitly typed — the same
    // silent-override this function exists to remove, only slower.
    const r = rebaseParFromTarget(16, { smart_group: 'guest_consumable' }, prop())
    expect(r.auto_adjust).toBe(false)

    const stats = { avg_rate_per_guest_night: 5, sample_count: 99 }
    const item  = { ...asItem('guest_consumable', r.base_qty, r.par_level), auto_adjust: r.auto_adjust }
    expect(resolvePar(item, prop(), stats).source).toBe('smart_formula')
    expect(resolvePar(item, prop(), stats).par).toBe(16)
  })

  it('goes STATIC at 0 — that is a PM saying they do not stock this here', () => {
    // Also the arithmetic edge: the inverse of 0 is negative. The editor's
    // input allows min={0}, so this is reachable, not theoretical.
    const r = rebaseParFromTarget(0, { smart_group: 'bathroom_essential' }, prop())
    expect(r).toMatchObject({ par_mode: 'static', smart_group: null, par_level: 0 })
    expect(r.base_qty).toBeGreaterThan(0)
  })

  it('goes STATIC when there is no smart group to scale by', () => {
    const r = rebaseParFromTarget(9, { smart_group: null }, prop())
    expect(r).toMatchObject({ par_mode: 'static', smart_group: null, par_level: 9 })
  })

  it('treats an unset multiplier as 1 rather than collapsing to zero', () => {
    // bathrooms 0/null means "nobody filled this in", not "no bathrooms".
    // Re-basing against 0 would divide by zero and write Infinity.
    const r = rebaseParFromTarget(6, { smart_group: 'bathroom_essential' }, prop({ bathrooms: 0 }))
    expect(Number.isFinite(r.base_qty)).toBe(true)
    expect(resolvePar(asItem('bathroom_essential', r.base_qty, r.par_level), prop({ bathrooms: 0 }), null).par).toBe(6)
  })

  it('rejects a non-finite target instead of writing NaN into par_level', () => {
    for (const bad of [NaN, Infinity, -Infinity, -5]) {
      const r = rebaseParFromTarget(bad, { smart_group: 'bathroom_essential' }, prop())
      expect(r.par_mode).toBe('static')
      expect(Number.isFinite(r.par_level)).toBe(true)
    }
  })
})

describe('smartScaleFactor', () => {
  it('is the single factor both the formula and its inverse use', () => {
    // Forward and inverse drifting apart is the failure mode that makes a
    // re-based base_qty stop reproducing the PM's number, so they share this.
    const p = prop({ bathrooms: 2 })
    expect(smartScaleFactor('bathroom_essential', p)).toBeCloseTo(2 * 1.15, 10)
    expect(smartScaleFactor('bedroom_essential',  p)).toBeCloseTo(3 * 1.20, 10)
    expect(smartScaleFactor('guest_consumable',   p)).toBeCloseTo(8 * 1.10, 10)
  })
})
