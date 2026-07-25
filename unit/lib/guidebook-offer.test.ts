import { describe, it, expect } from 'vitest'
import { formatOffer } from '@/lib/guidebook/offer'

describe('formatOffer', () => {
  describe('percentage', () => {
    it('formats a percentage offer with an item', () => {
      expect(formatOffer('percentage', 20, 'breakfast', null)).toBe(
        '20% off breakfast — just show this screen'
      )
    })

    it('formats a percentage offer with no item', () => {
      expect(formatOffer('percentage', 15, null, null)).toBe(
        '15% off — just show this screen'
      )
    })

    it('returns null when offerValue is null', () => {
      expect(formatOffer('percentage', null, 'breakfast', null)).toBeNull()
    })

    it('returns null when offerValue is 0', () => {
      expect(formatOffer('percentage', 0, 'breakfast', null)).toBeNull()
    })
  })

  describe('fixed_amount', () => {
    it('formats a whole-dollar fixed amount with an item', () => {
      expect(formatOffer('fixed_amount', 5, 'dessert', null)).toBe(
        '$5 off dessert — just show this screen'
      )
    })

    it('formats a fractional fixed amount with no item', () => {
      expect(formatOffer('fixed_amount', 2.5, null, null)).toBe(
        '$2.50 off — just show this screen'
      )
    })

    it('returns null when offerValue is null', () => {
      expect(formatOffer('fixed_amount', null, null, null)).toBeNull()
    })

    it('returns null when offerValue is 0', () => {
      expect(formatOffer('fixed_amount', 0, null, null)).toBeNull()
    })
  })

  describe('item', () => {
    it('formats a free item offer', () => {
      expect(formatOffer('item', null, 'appetizer', null)).toBe(
        'Free appetizer — just show this screen'
      )
    })

    it('returns null when offerItem is missing', () => {
      expect(formatOffer('item', null, null, null)).toBeNull()
    })
  })

  describe('custom', () => {
    it('returns the custom offer text verbatim', () => {
      expect(formatOffer('custom', null, null, '10% off your first order')).toBe(
        '10% off your first order'
      )
    })

    it('returns null when custom text is missing', () => {
      expect(formatOffer('custom', null, null, null)).toBeNull()
    })
  })

  describe('none', () => {
    it('returns null', () => {
      expect(formatOffer('none', null, null, null)).toBeNull()
    })
  })
})
