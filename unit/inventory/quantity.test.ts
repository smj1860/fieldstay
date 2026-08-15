import { describe, it, expect } from 'vitest'
import {
  parseQuantityInput,
  quantizeQuantity,
  isStorableQuantity,
  formatQuantity,
  QUANTITY_INPUT_STEP,
  MAX_QUANTITY,
} from '@/lib/inventory/quantity'

// ============================================================================
// Inventory quantities became numeric(12,2) in 20260815152007, because real
// stock is not always whole — half a case of paper towels, 1.5 gallons of
// cleaner.
//
// The defect this module replaces was silent in the worst way: every call site
// used parseInt, and parseInt('2.5') is 2. It does not throw and does not
// return NaN. A crew member who counted half a case recorded a whole one, the
// par comparison ran against the wrong number, and the purchase order built
// from it was wrong too — with nothing anywhere reporting a problem.
// ============================================================================

describe('parseQuantityInput', () => {
  it('keeps the fraction that parseInt silently dropped', () => {
    // The regression in one line. parseInt('2.5', 10) === 2.
    expect(parseQuantityInput('2.5')).toBe(2.5)
    expect(parseQuantityInput('0.5')).toBe(0.5)
    expect(parseQuantityInput('1.25')).toBe(1.25)
  })

  it('still handles whole numbers, which are most counts', () => {
    expect(parseQuantityInput('3')).toBe(3)
    expect(parseQuantityInput('0')).toBe(0)
  })

  it('returns null for empty input — uncounted is not a counted zero', () => {
    // The crew checklist distinguishes these: clearing the field returns the
    // item to uncounted rather than asserting there are none on hand.
    expect(parseQuantityInput('')).toBeNull()
    expect(parseQuantityInput('   ')).toBeNull()
  })

  it('rejects trailing garbage instead of silently taking the prefix', () => {
    // parseFloat('2abc') is 2 — the same class of silent acceptance as
    // parseInt('2.5'). Number() gives NaN, which is why it is used.
    expect(parseQuantityInput('2abc')).toBeNull()
    expect(parseQuantityInput('abc')).toBeNull()
  })

  it('rejects negatives — a count cannot be below zero', () => {
    expect(parseQuantityInput('-1')).toBeNull()
    expect(parseQuantityInput('-0.5')).toBeNull()
  })

  it('rejects Infinity rather than passing it to a numeric column', () => {
    expect(parseQuantityInput('Infinity')).toBeNull()
  })

  it('rounds beyond 2dp to what the column will actually hold', () => {
    expect(parseQuantityInput('2.999')).toBe(3)
    expect(parseQuantityInput('1.239')).toBe(1.24)
  })

  it('rounds a binary-inexact third decimal DOWN, and that is the documented answer', () => {
    // Pinned because it is surprising and because the alternative is worse.
    // "1.005" has no exact double: the nearest is 1.00499999999999989, so JS
    // rounds it to 1.00 while Postgres — parsing the literal text — would give
    // 1.01. Quantizing client-side means the UI and the row agree on one value
    // instead of it changing when it round-trips. Immaterial at the third
    // decimal of a stock count; a UI disagreeing with the database is not.
    expect(parseQuantityInput('1.005')).toBe(1)
  })

  it('clamps at the column ceiling instead of overflowing numeric(12,2)', () => {
    expect(parseQuantityInput('99999999999999')).toBe(MAX_QUANTITY)
  })
})

describe('quantizeQuantity', () => {
  it('absorbs binary floating point error from the +/- steppers', () => {
    // The crew checklist's buttons do arithmetic on a fractional count.
    // 0.1 + 0.2 is 0.30000000000000004, which numeric(12,2) cannot hold — and
    // an unrounded value reaching the submit payload fails the whole count.
    expect(quantizeQuantity(0.1 + 0.2)).toBe(0.3)
    expect(quantizeQuantity(2.5 - 1)).toBe(1.5)
  })

  it('leaves an already-storable value alone', () => {
    expect(quantizeQuantity(3)).toBe(3)
    expect(quantizeQuantity(2.25)).toBe(2.25)
  })
})

describe('isStorableQuantity', () => {
  it('accepts fractions — the whole point of the change', () => {
    expect(isStorableQuantity(2.5)).toBe(true)
    expect(isStorableQuantity(0)).toBe(true)
  })

  it.each([
    ['a string',   '5'],
    ['NaN',        Number.NaN],
    ['Infinity',   Number.POSITIVE_INFINITY],
    ['a negative', -1],
    ['null',       null],
    ['undefined',  undefined],
    ['an object',  {}],
  ])('rejects %s, which Postgres would answer with 22P02/22003', (_label, value) => {
    // Load-bearing beyond tidiness: the crew route answers 500 on a Postgres
    // error, and lib/dexie/net.ts treats >=500 as TRANSIENT — so one of these
    // reaching the database becomes a submission that retries forever.
    expect(isStorableQuantity(value)).toBe(false)
  })

  it('rejects a value past the column ceiling', () => {
    expect(isStorableQuantity(MAX_QUANTITY + 1)).toBe(false)
  })
})

describe('formatQuantity', () => {
  it('drops trailing zeros — most counts are whole', () => {
    expect(formatQuantity(3)).toBe('3')
    expect(formatQuantity(2.5)).toBe('2.5')
    expect(formatQuantity(2.25)).toBe('2.25')
  })

  it('renders nothing for an uncounted item', () => {
    expect(formatQuantity(null)).toBe('')
    expect(formatQuantity(undefined)).toBe('')
  })
})

describe('QUANTITY_INPUT_STEP', () => {
  it('permits 2dp, because step participates in HTML validation', () => {
    // Not cosmetic: with the implied step of 1, "2.5" is an INVALID input
    // value and submits as empty in some browsers — a field that looks like it
    // takes decimals and then refuses them.
    expect(QUANTITY_INPUT_STEP).toBe(0.01)
    expect(Number.isInteger(2.5 / QUANTITY_INPUT_STEP)).toBe(true)
    expect(Number.isInteger(2.25 / QUANTITY_INPUT_STEP)).toBe(true)
  })
})
