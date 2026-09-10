// lib/integrations/providers/lodgify.types.ts
// ============================================================================
// Raw Lodgify Public API v2 shapes.
//
// ⚠️ EVERY TYPE IN THIS FILE IS UNCONFIRMED AGAINST A LIVE RESPONSE.
//
// There is no Lodgify account connected to FieldStay, and docs.lodgify.com
// sits behind a bot challenge that refuses automated fetches, so these shapes
// come from Lodgify's published reference and third-party integration guides
// — not from a payload anyone here has seen. That is a materially weaker
// footing than Hostex (checked against its OpenAPI document) or even Hostaway
// (checked against a published field list).
//
// WHAT THAT CHANGES ABOUT THE CODE, rather than just being a disclaimer:
//
//   1. Every field except the identity ones is OPTIONAL here, and every
//      consumer in lodgify.mappers.ts treats absence as "this provider does
//      not tell us" rather than as a zero, a default, or a failure. A guessed
//      bedroom count overwrites a PM's correction on every sync
//      (hostaway.mappers.ts's header records what that cost); a guessed
//      status silently degrades every booking (see unmappedBookingStatus).
//   2. Nothing branches on a field this file could have got WRONG without
//      also being loud about it. An unrecognised status reports; an
//      unparseable list shape reports the keys it actually saw
//      (see lodgifyExtractItems in lodgify-api.ts).
//   3. `LodgifyBooking` deliberately does NOT model the money breakdown
//      beyond the one total. Netting a channel commission out of gross is the
//      single easiest thing to get backwards (hostaway.mappers.ts's
//      extractHostawayActualTotal exists because the two Hostaway fee fields
//      point in opposite directions), and doing it from an unverified field
//      name would put a wrong number on an owner statement. Gross, or
//      nothing.
//
// CONFIRM-BEFORE-TRUSTING checklist lives in
// docs/Integrations/lodgify/ENABLEMENT.md. Update this file from a real
// response the first time one is available, and delete the hedging with it.
// ============================================================================

/**
 * A Lodgify v2 list response.
 *
 * Documented as `{ count, items }`; some endpoints are reported to return a
 * bare array. Both are accepted by lodgifyExtractItems — this type describes
 * the enveloped form only.
 */
export interface LodgifyListEnvelope<T> {
  count?: number
  items?: T[]
}

/** GET /v2/properties */
export interface LodgifyProperty {
  /** The only field this integration REQUIRES. Everything else may be absent. */
  id: number

  name?:          string | null
  /** Lodgify's internal label; `name` is the guest-facing one. */
  internal_name?: string | null

  address?:       string | null
  city?:          string | null
  state?:         string | null
  /** Lodgify spells the postal code `zip` on the property record. */
  zip?:           string | null
  country_code?:  string | null

  latitude?:      number | string | null
  longitude?:     number | string | null

  /** IANA zone, when Lodgify has one for the property. */
  timezone_name?: string | null

  /** Present on the property in some responses, on `rooms[]` in others. */
  bedrooms?:      number | null
  bathrooms?:     number | null
  max_people?:    number | null

  rooms?:         LodgifyRoomType[] | null

  /** A delisted property. Excluded from the import — see the mapper. */
  is_active?:     boolean | null
}

/** GET /v2/properties/{id}/rooms — a property's room types. */
export interface LodgifyRoomType {
  id?:          number | null
  name?:        string | null
  max_people?:  number | null
  bedrooms?:    number | null
  bathrooms?:   number | null
}

/**
 * Lodgify booking status.
 *
 * Documented vocabulary is Booked / Tentative / Open / Declined, capitalised.
 * Matched case-insensitively by the mapper: a provider that changes the
 * casing of an enum is far more likely than one that changes its meaning, and
 * a case mismatch would route EVERY booking through unmappedBookingStatus to
 * 'tentative' — the exact failure that left 28 OwnerRez bookings tentative and
 * out of every revenue path for weeks.
 */
export type LodgifyBookingStatus = 'Booked' | 'Tentative' | 'Open' | 'Declined' | string

/** GET /v2/reservations/bookings and /v2/reservations/bookings/{id} */
export interface LodgifyBooking {
  /** Required. Becomes bookings.external_id. */
  id: number

  property_id?:  number | null

  /** YYYY-MM-DD. Lodgify calls check-in `arrival` and check-out `departure`. */
  arrival?:      string | null
  departure?:    string | null

  status?:       LodgifyBookingStatus | null

  /**
   * The booking channel, as Lodgify reports it. `source` is a machine-ish
   * token (e.g. 'Airbnb', 'Manual'); `source_text` is display copy. Both are
   * fed to the channel mapper, which is substring-based, so either spelling
   * lands on the right booking_source.
   */
  source?:       string | null
  source_text?:  string | null

  guest?:        LodgifyGuest | null

  /**
   * Gross booking value, as Lodgify reports it. NOT netted of any channel
   * commission — see this file's header for why nothing here attempts that.
   */
  total_amount?: number | string | null
  currency_code?: string | null

  /** Set when the booking has been moved to trash / cancelled. */
  is_deleted?:   boolean | null
  canceled_at?:  string | null

  created_at?:   string | null
  updated_at?:   string | null

  /**
   * Whether this is an owner block rather than a paying stay. Lodgify's own
   * flag name here is NOT confirmed; the mapper treats absence as "a normal
   * guest stay", which is the safe direction — a block mis-read as a stay
   * still produces a turnover, whereas a stay mis-read as a block would
   * silently drop revenue.
   */
  is_owner_stay?: boolean | null
}

export interface LodgifyGuest {
  name?:  string | null
  email?: string | null
  /** Never logged, never written to audit metadata. */
  phone?: string | null
}

/**
 * GET /v2/webhooks/list — a subscription Lodgify already holds for this
 * account. Used to make registration idempotent.
 */
export interface LodgifyWebhookSubscription {
  id?:         number | string | null
  event?:      string | null
  target_url?: string | null
}

/**
 * The events Lodgify is documented to publish.
 *
 * FieldStay subscribes to the booking ones only. `rate_change` and
 * `guest_message_received` have no consumer here, and a subscription with no
 * consumer is a delivery we authenticate and drop — cost without benefit.
 */
export const LODGIFY_BOOKING_EVENTS = [
  'booking_new_any_status',
  'booking_change',
  'booking_status_change',
] as const

export type LodgifyBookingEvent = typeof LODGIFY_BOOKING_EVENTS[number]
