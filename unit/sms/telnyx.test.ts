import { describe, it, expect } from 'vitest'
import { buildSponsorLine } from '@/lib/sms/telnyx'

describe('buildSponsorLine', () => {
  it('uses the custom message verbatim when offer_type is custom', () => {
    const result = buildSponsorLine(
      "Stephen's Burger Barn", 'custom', null, null, 'Try our new smash burger!', 0.4
    )
    expect(result).toBe('Try our new smash burger!')
  })

  it('falls back to a default line when offer_type is custom but the text is empty', () => {
    const result = buildSponsorLine("Stephen's Burger Barn", 'custom', null, null, null, 0.4)
    expect(result).toBe("Try Stephen's Burger Barn (0.4 mi away) — a local favorite.")
  })

  it('names the business for a percentage offer', () => {
    const result = buildSponsorLine('Sunrise Coffee', 'percentage', 20, null, null, 0.4)
    expect(result).toBe('Sunrise Coffee has 20% off — just show this screen (0.4 mi away).')
  })

  it('names the business for a fixed-amount offer with an item', () => {
    const result = buildSponsorLine('River Bistro', 'fixed_amount', 5, 'dessert', null, 0.8)
    expect(result).toBe('River Bistro has $5 off dessert — just show this screen (0.8 mi away).')
  })

  it('names the business with no discount line at all when offer_type is none', () => {
    const result = buildSponsorLine('Lakeview Marina', 'none', null, null, null, 1.2)
    expect(result).toBe('Try Lakeview Marina (1.2 mi away) — a local favorite.')
  })

  it('omits the distance suffix when distance is unavailable', () => {
    const result = buildSponsorLine('Lakeview Marina', 'none', null, null, null, null)
    expect(result).toBe('Try Lakeview Marina — a local favorite.')
  })
})
