/**
 * OwnerRez partnership launch offer, announced 2026-11.
 * OWNERREZ_URL is OwnerRez's tracked partner link, supplied by Paul Hall (OwnerRez).
 * Do not edit it. They measure referrals from these exact UTM values.
 */
export const OWNERREZ_URL =
  'https://www.ownerrez.com/?utm_source=fieldstay&utm_medium=website&utm_campaign=fieldstay' as const

export const OWNERREZ_PROMO_CODE = 'OWNERREZ50' as const

/** First instant the offer is over: 2027-01-01 00:00 America/Chicago (CST, UTC-6). */
export const OWNERREZ_OFFER_ENDS_AT = new Date('2027-01-01T06:00:00Z')

export function isOwnerRezOfferActive(now: Date = new Date()): boolean {
  return now.getTime() < OWNERREZ_OFFER_ENDS_AT.getTime()
}
