import type { GuidebookOfferType } from '@/types/database'

const OFFER_TYPES: readonly GuidebookOfferType[] = ['percentage', 'fixed_amount', 'item', 'custom', 'none']

/**
 * Narrows guidebook_sponsors.offer_type — a TEXT column with a CHECK
 * constraint, so PostgREST hands it back as a bare `string` — to the union the
 * formatters actually branch on.
 *
 * Same pattern and same reason as asExtensionContactMethod for
 * extension_contact_method. Unrecognised input falls back to 'none', which
 * formatOffer already treats as "no offer to show" — the safe direction: a
 * sponsor line is omitted rather than rendered from a value nothing
 * understands.
 */
export function asOfferType(value: string | null | undefined): GuidebookOfferType {
  return OFFER_TYPES.includes(value as GuidebookOfferType) ? (value as GuidebookOfferType) : 'none'
}

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
