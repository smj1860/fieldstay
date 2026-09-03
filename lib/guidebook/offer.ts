import type { GuidebookOfferType, GuidebookSlotType } from '@/types/database'

/**
 * Every member of GuidebookOfferType, as a Record so TypeScript enforces
 * EXHAUSTIVENESS: add a value to the union and this stops compiling until it
 * is listed here.
 *
 * That, not lookup speed, is the reason this is not a plain array. A
 * five-element array's `.includes()` is if anything faster than a Set — but an
 * array has no compile-time link back to the union, so a newly added offer
 * type would silently fall through asOfferType() to 'none' and every sponsor
 * using it would render no offer at all, with nothing failing anywhere. The
 * fallback that makes unknown input safe is exactly what makes a MISSING entry
 * invisible, so the list has to be checked by the compiler rather than by
 * whoever remembers to update it.
 */
const OFFER_TYPES: Record<GuidebookOfferType, true> = {
  percentage:   true,
  fixed_amount: true,
  item:         true,
  custom:       true,
  none:         true,
}

const OFFER_TYPE_KEYS = new Set<string>(Object.keys(OFFER_TYPES))

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
  return OFFER_TYPE_KEYS.has(value ?? '') ? (value as GuidebookOfferType) : 'none'
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

/**
 * Every member of GuidebookSlotType, as a Record for the same reason
 * OFFER_TYPES is one: adding a value to the union must stop this compiling
 * until it is listed, rather than silently falling through to the catch-all.
 *
 * That failure would be quiet and expensive here — a new named slot missing
 * from this list would be narrowed to 'other', which the resolver treats as
 * unnamed filler, so the slot would never be selected as its own category and
 * its sponsors would compete for leftover space. That is the same class of bug
 * as outdoor_adventure never firing.
 */
const SLOT_TYPES: Record<GuidebookSlotType, true> = {
  morning_brew:      true,
  dinner_pints:      true,
  rainy_day:         true,
  outdoor_adventure: true,
  general:           true,
  other:             true,
}

const SLOT_TYPE_KEYS = new Set<string>(Object.keys(SLOT_TYPES))

/**
 * Narrows guidebook_sponsors.slot_type — TEXT with a CHECK constraint, so
 * PostgREST hands it back as a bare `string` — to the union the resolver and
 * both nudge crons branch on.
 *
 * Unrecognised input falls back to 'other': a sponsor still appears, as
 * unnamed filler, rather than vanishing from the guidebook entirely. The DB
 * CHECK makes that unreachable in practice.
 */
export function asSlotType(value: string | null | undefined): GuidebookSlotType {
  return SLOT_TYPE_KEYS.has(value ?? '') ? (value as GuidebookSlotType) : 'other'
}
