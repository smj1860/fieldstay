// lib/inventory/quantity.ts
// ============================================================================
// Parsing and validation for inventory quantities.
//
// Counts are fractional as of 20260815152007: inventory_items.current_quantity
// and inventory_count_items.quantity_counted are numeric(12,2), because real
// stock is not always whole — half a case of paper towels, 1.5 gallons of
// cleaner. Before that they were `integer` and every call site used parseInt,
// which does not reject "2.5"; it silently returns 2. A crew member counting
// half a case recorded a whole one and nothing anywhere said otherwise.
//
// This module exists because that parse happens in four places (the crew
// checklist, two PM inventory inputs, the shared item card) plus the route
// that validates the submitted payload. Four copies of "parse a decimal, clamp
// at zero, round to 2dp" is four chances for one of them to keep truncating.
//
// SCALE is 2, matching the column. A value with more precision is not a
// validation error — it is rounded HERE, before the write, so the number the UI
// shows is the number the row holds.
//
// Rounding client-side rather than leaving it to Postgres is deliberate,
// because the two do not always agree at the third decimal: JS parses "1.005"
// to the nearest double, 1.00499999999999989, and rounds that to 1.00, while
// Postgres parses the literal text exactly and rounds to 1.01. Quantizing here
// gives one answer instead of a value that changes when it round-trips. At the
// third decimal of an inventory count that difference is immaterial; a UI
// disagreeing with the database is not.
// ============================================================================

/** Decimal places stored by numeric(12,2). Keep in step with the column. */
export const QUANTITY_DECIMAL_PLACES = 2

/**
 * `step` for a quantity <input type="number">.
 *
 * Load-bearing, not cosmetic: an input's step participates in HTML validation,
 * so the default step of 1 makes "2.5" an INVALID value that submits as empty
 * in some browsers. A field that accepts decimals must say so here too.
 */
export const QUANTITY_INPUT_STEP = 0.01

const FACTOR = 10 ** QUANTITY_DECIMAL_PLACES

/** Largest value numeric(12,2) can hold — 10 integer digits before the point. */
export const MAX_QUANTITY = 9_999_999_999.99

/**
 * Rounds to the column's scale.
 *
 * Via a factor rather than toFixed so the result is a number, and applied on
 * every write path because JS arithmetic produces values the column cannot
 * hold: 0.1 + 0.2 is 0.30000000000000004, and the +/- buttons on the crew
 * checklist do exactly that kind of arithmetic.
 */
export function quantizeQuantity(value: number): number {
  return Math.round(value * FACTOR) / FACTOR
}

/**
 * Parses a quantity typed into an input.
 *
 * Returns null for empty input — which callers treat as UNCOUNTED, distinct
 * from a counted zero — and null for anything unparseable, so a caller can
 * leave the previous value alone rather than writing NaN or a silent 0.
 *
 * Note `Number()` and not `parseFloat`: parseFloat("2abc") is 2, which is the
 * same class of silent-acceptance bug as parseInt("2.5") being 2.
 */
export function parseQuantityInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0) return null

  return quantizeQuantity(Math.min(parsed, MAX_QUANTITY))
}

/**
 * Whether a value off the wire is a storable quantity.
 *
 * The boundary check for submitted counts. A float, a NaN, an Infinity or a
 * negative reaching Postgres raises 22P02/22003 and the route answers 500 —
 * and lib/dexie/net.ts treats >=500 as TRANSIENT, so that submission retries
 * forever as a poison pill that never drains. Terminal client errors have to
 * be caught here and answered 400.
 *
 * Fractional values are now valid; excess precision is NOT rejected here
 * because callers quantize first. What stays invalid: non-numbers, NaN,
 * Infinity, negatives, and anything past the column's range.
 */
export function isStorableQuantity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_QUANTITY
  )
}

/**
 * Formats a quantity for display.
 *
 * Trailing zeros are dropped — "3" reads better than "3.00" for the whole
 * numbers that are still the overwhelming majority of counts, while 2.5 and
 * 2.25 render exactly.
 */
export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return ''
  return String(quantizeQuantity(value))
}
