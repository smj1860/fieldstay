// lib/inventory/stock-status.ts
// ============================================================================
// THE one definition of what an inventory item's stock level MEANS.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
//   below par   → red
//   at par      → yellow for a CONSUMABLE, green for a DURABLE
//   above par   → green
//   never counted → uncounted (no colour — we don't know anything yet)
//
// The durable exception is the whole point of the flag. Par means two
// different things depending on what the item is:
//
//   * For a consumable (toilet paper, dish soap, Swiffer refills), par is a
//     REORDER POINT. Sitting exactly on it means the next turnover takes you
//     under, so yellow is a real warning.
//   * For a durable (mattress protector, broom, coffee maker, pillows), par is
//     a COMPLETE SET. One broom per property IS the correct, permanent, fully
//     stocked state. Painting that yellow forever means the amber badge stops
//     meaning anything — and it was the bulk of the noise: 69 of one org's
//     items sat exactly at par.
//
// ── Why this module exists rather than four copies of two comparisons ───────
//
// It was four copies, and they had already drifted into two different answers
// to the same question:
//
//   inventory-manager.tsx   qty <= par → critical,  qty <= par*1.2 → low
//   portfolio-view.tsx ×2   qty <= par → critical,  qty <= par*1.2 → low
//   crew InventoryView.tsx  qty <  par → low
//   notifications.ts        qty <  par → below par
//   account-tools.ts        qty <  par → below par
//   inventory_below_par_for_org (RPC)  qty < par
//
// So the Ops Snapshot counted 43 items below par while the inventory page
// showed 113 in red, on the same data at the same moment, and neither was
// wrong — they were answering differently-defined questions. That is what
// made the inventory page look stale when it was perfectly current.
//
// `atOrBelowPar` is deliberately NOT exported: nothing should ask that
// question any more. The restock question is `needsRestock`, which is strictly
// below par, because ordering `par - qty` for an at-par item orders ZERO — and
// that shipped, putting a zero-quantity line on the aggregated purchase list
// for every at-par item.
// ============================================================================

/** Colour bands, named for what the PM sees rather than for a severity word. */
export type StockStatus = 'uncounted' | 'red' | 'yellow' | 'green'

/**
 * The minimum an item must expose to be classified.
 *
 * A structural type rather than the full row: every caller passes a different
 * shape (the page's InventoryItem, the portfolio row, the crew's Dexie
 * record), and none of them should have to widen to a common interface to ask
 * this question.
 */
export interface StockLevels {
  current_quantity:        number
  par_level:               number
  first_count_recorded_at: string | null
  /**
   * False for equipment and linens — anything where par is a complete set
   * rather than a reorder point.
   *
   * Optional, and absent means CONSUMABLE. That is the cautious default in the
   * only direction that matters: an unclassified durable shows yellow at par,
   * which is mild noise, while an unclassified consumable showing green at par
   * is how you run out of toilet paper.
   */
  is_consumable?: boolean | null
}

/** True when the item has never been counted, so no level is known. */
function isUncounted(item: StockLevels): boolean {
  return !item.first_count_recorded_at
}

/**
 * What colour this item is.
 *
 * Note the ordering: the uncounted check comes FIRST, because a row with
 * current_quantity 0 and par 1 that has never been counted is not "out of
 * stock" — it is unknown, and a red badge for it is a false alarm the PM
 * cannot act on.
 */
export function stockStatus(item: StockLevels): StockStatus {
  if (isUncounted(item)) return 'uncounted'
  if (item.current_quantity < item.par_level) return 'red'
  if (item.current_quantity > item.par_level) return 'green'

  // Exactly at par. Absent flag = consumable, per StockLevels.is_consumable.
  return item.is_consumable === false ? 'green' : 'yellow'
}

/**
 * Should this item be reordered, and how many units?
 *
 * STRICTLY below par, for both. An at-par item needs `par - qty` = 0 units,
 * so including it produced a purchase-list line for nothing — see the header.
 */
export function needsRestock(item: StockLevels): boolean {
  return !isUncounted(item) && item.current_quantity < item.par_level
}

/** Units required to bring an item back to par. Zero when it is not short. */
export function restockQuantity(item: StockLevels): number {
  return Math.max(0, item.par_level - item.current_quantity)
}

/** CSS variable for an item's badge/tint, or undefined for no tint. */
export function stockStatusColorVar(status: StockStatus): string | undefined {
  switch (status) {
    case 'red':    return 'var(--accent-red)'
    case 'yellow': return 'var(--accent-amber)'
    case 'green':  return 'var(--accent-green)'
    default:       return undefined
  }
}

/** PM-facing label. Separate from the status key — see CLAUDE.md on renaming. */
export function stockStatusLabel(status: StockStatus): string {
  switch (status) {
    case 'red':    return 'Below par'
    case 'yellow': return 'At par'
    case 'green':  return 'Stocked'
    default:       return 'Not counted'
  }
}
