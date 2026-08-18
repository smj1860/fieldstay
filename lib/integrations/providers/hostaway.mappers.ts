// lib/integrations/providers/hostaway.mappers.ts
// ============================================================================
// Pure raw-Hostaway -> normalized-FieldStay mapping. No I/O, no org context —
// the writers supply org_id. Same split as hospitable.ts/hospitable.mappers.ts
// and hostex.ts/hostex.mappers.ts.
//
// These moved OUT of lib/inngest/functions/hostaway/initial-sync.ts, which
// hand-rolled its own `properties` upsert instead of going through
// upsertNormalizedProperties(). Two things came with that:
//
//   - `bedrooms: listing.bedrooms ?? 1` INVENTED a room count. A PM who
//     corrected a 1-bedroom default to four had it overwritten on the next
//     sync — the provider's fabricated default beating the only real number in
//     the system. That is the exact defect NormalizedPropertyFacts' nullable
//     room counts exist to prevent, so the mapper below passes null through.
//   - No audit trail for overwriting the four PM-editable content fields,
//     which logContentOverwrites() in upsert-normalized.ts provides.
// ============================================================================

import type { NormalizedProperty } from '@/lib/properties/normalize'
import type { NormalizedBooking } from '@/lib/bookings/normalize'
import { unmappedBookingStatus } from '@/lib/bookings/normalize'
import { resolveHospitableTimezone } from '@/lib/integrations/providers/hospitable.mappers'
import type { HostawayListing, HostawayReservation, HostawayReview } from './hostaway'

// ── Properties ───────────────────────────────────────────────────────────────

/** A finite, non-negative count, or null when the provider omitted it. */
function optionalCount(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

/** A usable coordinate, or null. 0/0 is in the Gulf of Guinea, not a property. */
function optionalCoord(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return null
  return value
}

/** Trimmed, or null for absent/blank — '' would defeat upsert-normalized's null checks. */
function optionalText(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * Maps a raw Hostaway listing into the shared NormalizedProperty shape.
 *
 * Hostaway is the best-supplied of the three PMS providers here: unlike
 * Hostex's single free-form address string, it returns STRUCTURED address
 * fields AND lat/lng, so no address parsing and no Mapbox ZIP geocode is
 * needed for a listing that carries coordinates. upsert-normalized falls back
 * to geocoding the ZIP for the ones that don't.
 *
 * That matters beyond tidiness: auto-assign-turnover.ts scores crew proximity
 * only when BOTH the property and the crew member have coordinates, so a
 * coordinate-less property silently drops the distance signal and assigns on
 * reliability and capacity alone.
 *
 * `externalListingName` is preferred over `name` because it is the
 * guest-facing title; `name` is Hostaway's internal label.
 */
export function hostawayListingToNormalized(listing: HostawayListing): NormalizedProperty {
  return {
    external_id: String(listing.id),
    name:
      optionalText(listing.externalListingName) ??
      optionalText(listing.name) ??
      `Hostaway listing ${listing.id}`,

    address: optionalText(listing.address),
    city:    optionalText(listing.city),
    state:   optionalText(listing.state),
    zip:     optionalText(listing.zipcode),

    // Passed through when Hostaway has them, null when it does not — NEVER a
    // guessed default. See this file's header for what `?? 1` cost.
    bedrooms:   optionalCount(listing.bedrooms),
    bathrooms:  optionalCount(listing.bathrooms),
    max_guests: optionalCount(listing.maxGuests),

    // GET /listings carries no check-in/out time in the shape we type, so
    // these are FieldStay's defaults rather than Hostaway's truth. Same
    // position as Hostex.
    checkin_time:  '15:00',
    checkout_time: '11:00',

    // No IANA zone from Hostaway either; derive from the state, the same
    // fallback path hostexPropertyToNormalized and
    // hospitablePropertyToNormalized both use.
    timezone: resolveHospitableTimezone(null, optionalText(listing.state)),

    // Not exposed by GET /listings with includeResources=0, which is what the
    // fetcher requests. null rather than {} — an empty amenity map would read
    // as "confirmed to have none" to anything that later seeds assets from it.
    amenities:       null,
    smoking_allowed: null,
    pets_allowed:    null,
    events_allowed:  null,

    // The four PM-editable content fields. Hostaway exposes none of them on
    // the listing shape, so null leaves whatever the PM has entered alone.
    wifi_name:           null,
    wifi_password:       null,
    access_instructions: null,
    house_manual:        null,

    lat: optionalCoord(listing.lat),
    lng: optionalCoord(listing.lng),
  }
}

// ── Reservations ─────────────────────────────────────────────────────────────

/**
 * Hostaway reservation status -> booking_status enum.
 *
 * 'inquiry' and 'new' land on 'tentative' rather than 'confirmed': neither is
 * a committed stay, and generating a turnover for one would put a cleaner on a
 * job that may never exist. 'modified' IS confirmed — Hostaway uses it for an
 * accepted reservation that was subsequently changed, not for a pending one.
 */
export function mapHostawayStatus(status: string): NormalizedBooking['status'] {
  switch (status) {
    case 'confirmed':
    case 'modified':   return 'confirmed'
    case 'new':
    case 'inquiry':
    case 'tentative':  return 'tentative'
    case 'cancelled':  return 'cancelled'
    default:           return unmappedBookingStatus('hostaway', status)
  }
}

/**
 * Hostaway channelName -> booking_source enum.
 *
 * Hostaway's channel list is wider than the enum (agoda, expedia, tripadvisor,
 * marriott and custom channels have no member), so those land on 'other' —
 * which is what the enum's 'other' is for, not a mapping failure.
 */
export function mapHostawayChannel(channel: string | null | undefined): NormalizedBooking['source'] {
  const c = (channel ?? '').toLowerCase()
  if (!c)                                     return 'other'
  if (c.includes('airbnb'))                   return 'airbnb'
  if (c.includes('vrbo') || c.includes('homeaway')) return 'vrbo'
  if (c.includes('booking'))                  return 'booking_com'
  if (c.includes('direct') || c.includes('manual')) return 'direct'
  return 'other'
}

/** A positive, finite money amount, or null. Blank/zero/garbage all collapse to null. */
function optionalAmount(value: number | undefined | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value
}

/**
 * The owner-facing money for this stay: what the guest paid, LESS the
 * commission the channel takes out of the host's payout.
 *
 * ── Which fee is subtracted, and why only that one ──────────────────────────
 *
 * Hostaway carries two channel-fee fields and they point in opposite
 * directions. Per Hostaway's own financial-reporting documentation:
 *
 *   * `hostChannelFee`  — "the commission the channels charge you". Comes OUT
 *                         of the host payout. This is the one to subtract.
 *   * `guestChannelFee` — a separate line in the guest's price breakdown, paid
 *                         BY the guest. Subtracting it would understate owner
 *                         revenue by money the owner never lost.
 *
 * Both were reclassified from type `fee` to type `commissions` in Hostaway's
 * 2024-04-17 / 2024-05-15 changelog entries, which is where the exact spelling
 * of each name comes from. Getting the two the wrong way round is not a
 * rounding error — on Booking.com it is a double-digit percentage of the
 * statement, in the wrong direction.
 *
 * ── Why this is written to tolerate the field being absent ──────────────────
 *
 * There is no Hostaway account connected to production, so this could NOT be
 * checked against a live payload — only against the published field list. An
 * absent `hostChannelFee` therefore returns gross, exactly what shipped
 * before, rather than a null that would be read as "no revenue". The netting
 * turns itself on when the field actually arrives, and until then the
 * behaviour is unchanged rather than speculatively different.
 *
 * A fee at or above the gross is treated as absent for the same reason Hostex's
 * equivalent guards `net > 0`: a non-positive payout is data we do not
 * understand, and gross is at least anchored to a real number. Returning null
 * would be worse than merely high — booking-events.ts then falls back to a
 * nights * avg_nightly_rate estimate, which is anchored to nothing.
 */
export function extractHostawayActualTotal(res: HostawayReservation): number | null {
  const gross = optionalAmount(res.totalPrice)
  if (gross === null) return null

  // NOT guestChannelFee — see above.
  const hostFee = optionalAmount(res.hostChannelFee)
  if (hostFee === null) return gross

  const net = gross - hostFee
  return net > 0 ? net : gross
}

/**
 * Maps a raw Hostaway reservation into the shared NormalizedBooking shape.
 *
 * is_block is always false and stay_type always 'guest_stay', matching the
 * position Hostex shipped with: manually-blocked owner time does not appear
 * through /reservations at all — it lives on Hostaway's calendar endpoints —
 * and syncing those is a later phase. The previous version of this mapping
 * carried a `⚠️ Unconfirmed` comment saying the same thing less precisely.
 *
 * checkin_time/checkout_time are null rather than a repeated default: the
 * reservation shape carries no per-stay times, and the property's own
 * checkin_time/checkout_time are what the turnover generator should use.
 */
export function hostawayReservationToNormalized(res: HostawayReservation): NormalizedBooking {
  return {
    external_id:          String(res.id),
    property_external_id: res.listingId !== undefined && res.listingId !== null
      ? String(res.listingId)
      : null,

    checkin_date:  optionalText(res.arrivalDate),
    checkout_date: optionalText(res.departureDate),
    checkin_time:  null,
    checkout_time: null,

    status:      mapHostawayStatus(res.status),
    guest_name:  optionalText(res.guestName),
    guest_email: optionalText(res.guestEmail),
    source:      mapHostawayChannel(res.channelName),
    is_block:    false,
    stay_type:   'guest_stay',

    actual_total_amount: extractHostawayActualTotal(res),
  }
}

// ── Reviews ──────────────────────────────────────────────────────────────────

/** The `reviews` row this mapper produces, minus org/property linkage. */
export interface NormalizedHostawayReview {
  external_id:     string
  external_source: 'hostaway'
  /** Hostaway listing id as a string, for the caller to resolve to a UUID. */
  property_external_id: string
  guest_name:      string | null
  rating:          number
  review_text:     string
  review_date:     string | null
  response_status: 'pending' | 'posted'
  external_url:    null
}

/**
 * Hostaway's 'YYYY-MM-DD HH:MM:SS' to an ISO timestamp.
 *
 * The API returns NO timezone offset, so the zone is an assumption. UTC is the
 * one made here, and the error it can introduce is bounded at under a day —
 * enough to shift which calendar date a review displays under in an extreme
 * zone, never enough to reorder reviews meaningfully. Returning null instead
 * would lose the date entirely, which is worse for a column the reviews list
 * sorts by.
 */
function hostawayDateToIso(value: string | null | undefined): string | null {
  if (!value) return null
  const iso = value.trim().replace(' ', 'T')
  const parsed = new Date(`${iso}Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/**
 * Maps a Hostaway review into a `reviews` row, or null when it cannot be one.
 *
 * NULL IS THE COMMON CASE AND NOT AN ERROR. `reviews.rating` and
 * `reviews.review_text` are both NOT NULL, and Hostaway returns a review row
 * from the moment one is SCHEDULED — status 'awaiting' or 'pending', with
 * rating and publicReview both null. Those are placeholders for a review that
 * may never be written. Storing them would need invented values, and a
 * fabricated 0-star review with empty text would then be handed to RepuGuard
 * to draft a public reply to.
 *
 * So the guard is on the CONTENT, not the status name — a status list would
 * have to be guessed and would fail silently the first time Hostaway added one.
 *
 * Cancelled reviews are dropped for the same reason: a retracted review is not
 * something to reply to.
 *
 * response_status comes from `revieweeResponse` — the host's reply. Present
 * means the PM has already answered, which is what keeps RepuGuard from
 * drafting over the top of a reply that exists.
 */
export function hostawayReviewToNormalized(review: HostawayReview): NormalizedHostawayReview | null {
  if (review.isCancelled) return null
  if (review.type !== 'guest-to-host') return null

  const rating = typeof review.rating === 'number' && Number.isFinite(review.rating)
    ? review.rating
    : null
  const text = review.publicReview?.trim()

  if (rating === null || !text) return null

  return {
    external_id:          String(review.id),
    external_source:      'hostaway',
    property_external_id: String(review.listingMapId),
    guest_name:           optionalText(review.guestName ?? undefined),
    rating:               Math.round(rating),
    review_text:          text,
    review_date:          hostawayDateToIso(review.departureDate),
    response_status:      review.revieweeResponse?.trim() ? 'posted' : 'pending',
    // No confirmed per-review URL on Hostaway. Fabricating one would put a
    // dead link in the reviews list — the same reason reviews-client.tsx only
    // synthesises a fallback for OwnerRez.
    external_url:         null,
  }
}
