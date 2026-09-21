import { describe, it, expect } from 'vitest'
import { formatStartingCost } from '@/components/thumbtack/ThumbtackProCard'

describe('formatStartingCost', () => {
  it('formats a whole-dollar amount with no decimals', () => {
    expect(formatStartingCost(15000)).toBe('$150')
  })

  it('formats a fractional-dollar amount to two decimals', () => {
    expect(formatStartingCost(4999)).toBe('$49.99')
  })

  it('formats zero as $0', () => {
    expect(formatStartingCost(0)).toBe('$0')
  })

  // startingCostCents' unit and shape are unconfirmed against a live
  // Thumbtack response — a malformed payload could hand this a non-numeric,
  // negative, or NaN value, and the card should omit the line rather than
  // render "$NaN" or "$-5".
  it('returns null for a negative amount', () => {
    expect(formatStartingCost(-500)).toBeNull()
  })

  it('returns null for NaN', () => {
    expect(formatStartingCost(NaN)).toBeNull()
  })

  it('returns null for Infinity', () => {
    expect(formatStartingCost(Infinity)).toBeNull()
  })
})
