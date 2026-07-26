import type { GuidebookOfferType } from '@/types/database'

function formatOfferPrice(value: number): string {
  return value % 1 === 0 ? String(value) : value.toFixed(2)
}

function formatPercentageOffer(offerValue: number | null, offerItem: string | null): string | null {
  if (!offerValue) return null
  return offerItem
    ? `${offerValue}% off ${offerItem} — just show this screen`
    : `${offerValue}% off — just show this screen`
}

function formatFixedAmountOffer(offerValue: number | null, offerItem: string | null): string | null {
  if (!offerValue) return null
  const price = formatOfferPrice(offerValue)
  return offerItem
    ? `$${price} off ${offerItem} — just show this screen`
    : `$${price} off — just show this screen`
}

export function formatOffer(
  offerType:       GuidebookOfferType,
  offerValue:      number | null,
  offerItem:       string | null,
  customOfferText: string | null
): string | null {
  switch (offerType) {
    case 'percentage':
      return formatPercentageOffer(offerValue, offerItem)

    case 'fixed_amount':
      return formatFixedAmountOffer(offerValue, offerItem)

    case 'item':
      return offerItem ? `Free ${offerItem} — just show this screen` : null

    case 'custom':
      return customOfferText ?? null

    case 'none':
    default:
      return null
  }
}
