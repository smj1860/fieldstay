import { describe, it, expect } from 'vitest'
import {
  stockStatus,
  needsRestock,
  restockQuantity,
  stockStatusLabel,
  type StockLevels,
} from '@/lib/inventory/stock-status'

// ============================================================================
// The red / yellow / green rule, and the durable exception that is its point.
//
// Before this module there were three copies of the display thresholds and
// three of the restock threshold, and the two groups disagreed: the page used
// `qty <= par` for critical while the Ops Snapshot, notifications and the
// below-par RPC used `qty < par`. On the same org at the same moment that read
// as 113 red items versus 43 below par, and made the inventory page look stale
// when it was perfectly current. The 69 items sitting EXACTLY at par were the
// entire gap.
// ============================================================================

function item(over: Partial<StockLevels> = {}): StockLevels {
  return {
    current_quantity:        5,
    par_level:               5,
    first_count_recorded_at: '2026-08-01T00:00:00Z',
    ...over,
  }
}

describe('stockStatus', () => {
  it('is red below par', () => {
    expect(stockStatus(item({ current_quantity: 4, par_level: 5 }))).toBe('red')
    expect(stockStatus(item({ current_quantity: 0, par_level: 1 }))).toBe('red')
    // Fractional quantities are real — current_quantity is numeric(12,2).
    expect(stockStatus(item({ current_quantity: 4.5, par_level: 5 }))).toBe('red')
  })

  it('is green above par', () => {
    expect(stockStatus(item({ current_quantity: 6, par_level: 5 }))).toBe('green')
    // One unit over is GREEN, not a warning band. The old code called anything
    // up to par * 1.2 "low", so an item at par+1 with par 10 read as amber.
    expect(stockStatus(item({ current_quantity: 11, par_level: 10 }))).toBe('green')
  })

  it('is yellow at par for a consumable', () => {
    // Par is a REORDER POINT here: the next turnover takes you under.
    expect(stockStatus(item({ current_quantity: 5, par_level: 5, is_consumable: true })))
      .toBe('yellow')
  })

  it('is GREEN at par for a durable', () => {
    // THE POINT OF THE FLAG. Par is a COMPLETE SET for equipment and linens —
    // one broom per property IS the permanent correct state, and painting it
    // amber forever means the amber badge stops meaning anything.
    expect(stockStatus(item({ current_quantity: 5, par_level: 5, is_consumable: false })))
      .toBe('green')
    expect(stockStatus(item({ current_quantity: 1, par_level: 1, is_consumable: false })))
      .toBe('green')
  })

  it('treats a missing flag as CONSUMABLE, the cautious direction', () => {
    // An unclassified durable showing yellow is mild noise. An unclassified
    // consumable showing green at par is a stockout nobody was warned about,
    // so absence must mean consumable — never the reverse.
    expect(stockStatus(item({ current_quantity: 5, par_level: 5 }))).toBe('yellow')
    expect(stockStatus(item({ current_quantity: 5, par_level: 5, is_consumable: null })))
      .toBe('yellow')
  })

  it('does NOT let the durable flag override below-par', () => {
    // Durable or not, short is short. A property missing two of its four
    // mattress protectors is red.
    expect(stockStatus(item({ current_quantity: 2, par_level: 4, is_consumable: false })))
      .toBe('red')
  })

  it('is uncounted before the first count, whatever the numbers say', () => {
    // A never-counted row defaults to current_quantity 0, which would read as
    // "out of stock" — a red badge for something nobody has looked at yet is a
    // false alarm the PM cannot act on.
    expect(stockStatus(item({ first_count_recorded_at: null, current_quantity: 0, par_level: 10 })))
      .toBe('uncounted')
    expect(stockStatus(item({ first_count_recorded_at: null, current_quantity: 99, par_level: 1 })))
      .toBe('uncounted')
  })
})

describe('needsRestock / restockQuantity', () => {
  it('restocks strictly below par, never at par', () => {
    // THE BUG THIS PREVENTS. generateAggregatedPurchaseList skipped only
    // `qty > par`, so at-par items passed the filter — and their `needed` is
    // par - qty = ZERO. Every at-par item landed on the purchase list as a
    // zero-quantity line with a zero-quantity row under each property. One org
    // had 69 of them.
    expect(needsRestock(item({ current_quantity: 4, par_level: 5 }))).toBe(true)
    expect(needsRestock(item({ current_quantity: 5, par_level: 5 }))).toBe(false)
    expect(needsRestock(item({ current_quantity: 6, par_level: 5 }))).toBe(false)
  })

  it('never restocks an item nobody has counted', () => {
    // Ordering to par against an assumed zero would buy a full par level of
    // something that may already be on the shelf.
    expect(needsRestock(item({ first_count_recorded_at: null, current_quantity: 0, par_level: 8 })))
      .toBe(false)
  })

  it('restocks a durable that is genuinely short', () => {
    // The flag changes the at-par COLOUR, not whether a shortfall gets bought.
    expect(needsRestock(item({ current_quantity: 2, par_level: 4, is_consumable: false })))
      .toBe(true)
  })

  it('quantifies the shortfall, and is zero when there is none', () => {
    expect(restockQuantity(item({ current_quantity: 2, par_level: 5 }))).toBe(3)
    expect(restockQuantity(item({ current_quantity: 5, par_level: 5 }))).toBe(0)
    expect(restockQuantity(item({ current_quantity: 9, par_level: 5 }))).toBe(0)
    expect(restockQuantity(item({ current_quantity: 1.5, par_level: 3 }))).toBe(1.5)
  })
})

describe('stockStatusLabel', () => {
  it('gives every status a distinct PM-facing label', () => {
    const labels = (['red', 'yellow', 'green', 'uncounted'] as const).map(stockStatusLabel)
    expect(new Set(labels).size).toBe(4)
    expect(labels).toEqual(['Below par', 'At par', 'Stocked', 'Not counted'])
  })
})
