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
import type { HostawayListing, HostawayReservation } from './hostaway'

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

/**
 * The money for this stay.
 *
 * ⚠️ GROSS, not net — and this is the one number in this file that should be
 * revisited against a live Hostaway payload before an owner statement is
 * trusted.
 *
 * `totalPrice` is what the GUEST is charged. Hostex's equivalent helper
 * deliberately returns total_rate MINUS total_commission, because the
 * owner-facing figure is the payout, and Hospitable's prefers host.revenue
 * over guest.total_price for the same reason. Hostaway's reservation object
 * very likely carries the corresponding commission/payout fields — the shape
 * typed in hostaway.ts was written from their docs and does not include them,
 * so there is nothing to subtract yet.
 *
 * Passing gross overstates owner revenue by the channel's cut: roughly 3% on
 * Airbnb, up to ~15% on Booking.com. Passing null instead is not obviously
 * better — booking-events.ts then falls back to a nights * avg_nightly_rate
 * estimate, which is unanchored rather than merely high. So gross ships, named
 * and documented here rather than buried in a mapper expression, and the
 * follow-up is to type Hostaway's payout field and subtract.
 */
export function extractHostawayActualTotal(res: HostawayReservation): number | null {
  const gross = res.totalPrice
  if (typeof gross === 'number' && Number.isFinite(gross) && gross > 0) return gross
  return null
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
