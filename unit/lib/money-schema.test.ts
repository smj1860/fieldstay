import { describe, it, expect } from 'vitest'
import { parseMoneyAmount, parseMoneyAmountFromString, MAX_MONEY_AMOUNT } from '@/lib/schemas/money'

describe('parseMoneyAmount', () => {
  it('accepts a valid non-negative amount', () => {
    expect(parseMoneyAmount(100)).toEqual({ ok: true, amount: 100 })
  })

  it('rejects NaN as an invalid type, not a range violation', () => {
    const result = parseMoneyAmount(NaN)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Enter a valid amount.')
  })

  it('rejects Infinity', () => {
    expect(parseMoneyAmount(Infinity).ok).toBe(false)
  })

  it('rejects a negative amount', () => {
    expect(parseMoneyAmount(-5).ok).toBe(false)
  })
})

describe('parseMoneyAmountFromString — closes the pre-coercion gap', () => {
  // Number.parseFloat stops at the first non-numeric character rather than
  // rejecting the whole string, so parseMoneyAmount(Number.parseFloat(raw))
  // silently turned "100abc"/"100,000" into the number 100 before
  // MoneyAmountSchema ever saw anything wrong with it.
  it('accepts a plain decimal string', () => {
    expect(parseMoneyAmountFromString('100')).toEqual({ ok: true, amount: 100 })
    expect(parseMoneyAmountFromString('49.99')).toEqual({ ok: true, amount: 49.99 })
  })

  it('rejects trailing garbage that Number.parseFloat would silently truncate', () => {
    const result = parseMoneyAmountFromString('100abc')
    expect(result).toEqual({ ok: false, error: 'Enter a valid amount.' })
  })

  it('rejects a thousands-separated string Number.parseFloat would truncate to 100', () => {
    expect(parseMoneyAmountFromString('100,000')).toEqual({ ok: false, error: 'Enter a valid amount.' })
  })

  it('rejects leading garbage', () => {
    expect(parseMoneyAmountFromString('abc100').ok).toBe(false)
  })

  it('rejects a negative-looking string (only digits/decimal point are the valid shape)', () => {
    expect(parseMoneyAmountFromString('-5').ok).toBe(false)
  })

  it('still applies the underlying schema bounds after the shape check passes', () => {
    expect(parseMoneyAmountFromString(String(MAX_MONEY_AMOUNT + 1)).ok).toBe(false)
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseMoneyAmountFromString('  100  ')).toEqual({ ok: true, amount: 100 })
  })
})
