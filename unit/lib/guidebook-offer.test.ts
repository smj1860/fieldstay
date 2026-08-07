import { describe, it, expect } from 'vitest'
import { formatOffer, asOfferType } from '@/lib/guidebook/offer'

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

describe('asOfferType', () => {
  // guidebook_sponsors.offer_type is a TEXT column with a CHECK constraint, so
  // PostgREST hands it back as a bare string. This is the narrowing boundary.

  it.each(['percentage', 'fixed_amount', 'item', 'custom', 'none'])(
    'passes through the known offer type %s',
    (value) => {
      expect(asOfferType(value)).toBe(value)
    },
  )

  it.each([
    ['an unknown string', 'bogo'],
    ['an empty string',   ''],
    ['null',              null],
    ['undefined',         undefined],
  ])('falls back to none for %s', (_label, value) => {
    // 'none' is the safe direction: formatOffer renders nothing for it, so a
    // sponsor line is omitted rather than built from a value nothing
    // understands.
    expect(asOfferType(value)).toBe('none')
  })

  it('the fallback that makes unknown input safe is what makes a MISSING entry invisible', () => {
    // Which is why the member list is a Record<GuidebookOfferType, true> and
    // not an array: adding a value to the union fails the BUILD until it is
    // listed. There is no runtime assertion that can catch this — a forgotten
    // entry looks exactly like a genuinely unknown value, and every sponsor
    // using it would silently show no offer. Verified by reverting the Record
    // to an array and adding a union member: tsc stayed green.
    expect(asOfferType('bogo')).toBe('none')
  })
})
