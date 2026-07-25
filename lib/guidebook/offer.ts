import type { GuidebookOfferType } from '@/types/database'

export function formatOffer(
  offerType:       GuidebookOfferType,
  offerValue:      number | null,
  offerItem:       string | null,
  customOfferText: string | null
): string | null {
  switch (offerType) {
    case 'percentage':
      if (!offerValue) return null
      return offerItem
        ? `${offerValue}% off ${offerItem} — just show this screen`
        : `${offerValue}% off — just show this screen`

    case 'fixed_amount':
      if (!offerValue) return null
      return offerItem
        ? `$${offerValue % 1 === 0 ? offerValue : offerValue.toFixed(2)} off ${offerItem} — just show this screen`
        : `$${offerValue % 1 === 0 ? offerValue : offerValue.toFixed(2)} off — just show this screen`

    case 'item':
      return offerItem ? `Free ${offerItem} — just show this screen` : null

    case 'custom':
      return customOfferText ?? null

    case 'none':
    default:
      return null
  }
}
