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
})
