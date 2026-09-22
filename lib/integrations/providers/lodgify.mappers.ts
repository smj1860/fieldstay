// lib/integrations/providers/lodgify.mappers.ts
// ============================================================================
// Pure raw-Lodgify -> normalized-FieldStay mapping. No I/O, no org context —
// the writers supply org_id. Same split as hostex.ts/hostex.mappers.ts and
// hostaway.ts/hostaway.mappers.ts.
//
// EVERY FUNCTION HERE ASSUMES ITS INPUT MIGHT BE WRONG. lodgify.types.ts is
// built from published documentation rather than from a live response, so a
// field may be absent, differently named, or a string where a number was
// expected. The rules that follow from that, and which the tests in
// unit/integrations/lodgify-mappers.test.ts pin:
//
//   1. ABSENT IS NEVER A DEFAULT. Room counts map to null, not to 1. A
//      fabricated count is re-asserted over the PM's correction on every sync
//      — hostaway.mappers.ts's header records exactly what that cost, and
//      NormalizedPropertyFacts' nullable counts exist for it.
//   2. UNRECOGNISED IS NEVER SILENT. An unknown status goes through
//      unmappedBookingStatus, which reports to Sentry. A status vocabulary is
//      a closed set, so a mapper that disagrees with the provider disagrees
//      about EVERY booking, not one — the OwnerRez case where 28 live
//      reservations sat as 'tentative' for weeks, out of every revenue path,
//      with only a warn line nobody greps.
//   3. MONEY IS GROSS OR NOTHING. Nothing here nets a commission out of a
//      total, because the field that would carry one is unverified and a
//      subtraction in the wrong direction is a double-digit percentage error
//      on an owner statement.
// ============================================================================

import type { NormalizedProperty } from '@/lib/properties/normalize'
import type { NormalizedBooking } from '@/lib/bookings/normalize'
import { unmappedBookingStatus } from '@/lib/bookings/normalize'
import { resolveHospitableTimezone } from '@/lib/integrations/providers/hospitable.mappers'
import type { LodgifyBooking, LodgifyProperty } from './lodgify.types'

// ── Small shared coercions ───────────────────────────────────────────────────

/**
 * Trimmed, or null for absent/blank — '' would defeat upsert-normalized's
 * null checks.
 *
 * `|| null`, deliberately NOT `?? null`: an empty string is not nullish, so
 * `??` would pass '' straight through and defeat the entire purpose of this
 * helper.
 */
function optionalText(value: string | null | undefined): string | null {
  return value?.trim() || null
}

/** A finite, non-negative count, or null when the provider omitted it. */
function optionalCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

/**
 * A usable coordinate, or null.
 *
 * Accepts a numeric string as well as a number: Lodgify's own examples show
 * both, and a coordinate arriving as "32.8407" would otherwise be discarded
 * silently — which costs the crew-proximity signal in auto-assign-turnover.ts
 * rather than throwing anything.
 *
 * 0 is rejected: 0/0 is in the Gulf of Guinea, not a property.
 */
function optionalCoord(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n === 0) return null
  return n
}

/** A positive, finite money amount, or null. Blank/zero/garbage all collapse to null. */
function optionalAmount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/**
 * True only for a genuinely parseable 0 — never for absence, blank, or
 * garbage, all of which optionalAmount also collapses toward null-adjacent
 * outcomes but which mean "we don't know", not "the provider told us $0".
 */
function isGenuineZeroTotal(value: number | string | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n === 0
}

/** YYYY-MM-DD from either a date or a full timestamp; null for anything else. */
function optionalDate(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const head = trimmed.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null
}

// ── Properties ───────────────────────────────────────────────────────────────

/**
 * The first room type carrying a given count.
 *
 * Lodgify reports bedroom/bathroom/occupancy counts on the property in some
 * responses and on `rooms[]` in others. Reading both is what stops a
 * perfectly-supplied property importing as an unknown one — and null still
 * means null when NEITHER place has it.
 */
function fromRooms(prop: LodgifyProperty, field: 'bedrooms' | 'bathrooms' | 'max_people'): number | null {
  const direct = optionalCount(prop[field])
  if (direct !== null) return direct

  for (const room of prop.rooms ?? []) {
    const value = optionalCount(room[field])
    if (value !== null) return value
  }

  return null
}

/**
 * Maps a Lodgify property into the shared NormalizedProperty shape.
 *
 * WHAT LODGIFY DOES NOT SEND, and what happens instead:
 *
 *   - No check-in/check-out times on the property record we type, so these
 *     take FieldStay's defaults for the PM to correct. Same position as
 *     Hostex and Hostaway.
 *   - No amenity map. null rather than {} — an empty amenity map reads as
 *     "confirmed to have none" to anything that later seeds assets from it.
 *   - None of the four PM-EDITABLE content fields (wifi_name, wifi_password,
 *     access_instructions, house_manual). They are mapped to null, which
 *     upsert-normalized writes through as "leave the existing value alone",
 *     so the PM's own entries survive every sync. Lodgify DOES hold
 *     guest-facing content on its booking/property records; if a later phase
 *     reads it, map it here first — the audit trail for replacing a PM's text
 *     is logContentOverwrites(), and it only fires for values that reach it.
 */
export function lodgifyPropertyToNormalized(prop: LodgifyProperty): NormalizedProperty {
  const state = optionalText(prop.state)

  return {
    external_id: String(prop.id),

    // The guest-facing title first, Lodgify's internal label second, and a
    // last-resort label that at least names the id — never an empty string,
    // which would render as a nameless row in every property list.
    name:
      optionalText(prop.name) ??
      optionalText(prop.internal_name) ??
      `Lodgify property ${prop.id}`,

    address: optionalText(prop.address),
    city:    optionalText(prop.city),
    state,
    zip:     optionalText(prop.zip),

    // null, never a guessed default — see this file's header.
    bedrooms:   fromRooms(prop, 'bedrooms'),
    bathrooms:  fromRooms(prop, 'bathrooms'),
    max_guests: fromRooms(prop, 'max_people'),

    checkin_time:  '15:00',
    checkout_time: '11:00',

    // Lodgify's own IANA zone when it has one, the state-derived fallback
    // otherwise — the same path every other provider mapper here takes.
    timezone: resolveHospitableTimezone(optionalText(prop.timezone_name), state),

    amenities:       null,
    smoking_allowed: null,
    pets_allowed:    null,
    events_allowed:  null,

    wifi_name:           null,
    wifi_password:       null,
    access_instructions: null,
    house_manual:        null,

    lat: optionalCoord(prop.latitude),
    lng: optionalCoord(prop.longitude),
  }
}

/**
 * Whether a property should be imported at all.
 *
 * Only an EXPLICIT `is_active: false` excludes one. Absence means "Lodgify did
 * not tell us", and treating that as inactive would import zero properties
 * from an account whose response shape differs by one field name — a silent,
 * total failure that reads as "this PM has no listings".
 */
export function isLodgifyPropertyImportable(prop: LodgifyProperty): boolean {
  return prop.is_active !== false && prop.id !== undefined && prop.id !== null
}

// ── Bookings ─────────────────────────────────────────────────────────────────

/**
 * Lodgify booking status -> booking_status enum.
 *
 * Matched case-INSENSITIVELY. Lodgify documents capitalised values ('Booked'),
 * and a provider changing an enum's casing is far likelier than one changing
 * its meaning — but a case-sensitive match would route every booking through
 * unmappedBookingStatus to 'tentative', which is the OwnerRez failure exactly.
 *
 * 'Open' is an unconfirmed enquiry, not a committed stay, so it lands on
 * 'tentative': generating a turnover for one would put a cleaner on a job that
 * may never exist. 'Declined' is a stay that will not happen, which is what
 * 'cancelled' means to everything downstream.
 */
export function mapLodgifyStatus(status: string | null | undefined): NormalizedBooking['status'] {
  const raw = (status ?? '').trim()

  switch (raw.toLowerCase()) {
    case 'booked':    return 'confirmed'
    case 'tentative':
    case 'open':      return 'tentative'
    case 'declined':  return 'cancelled'
    default:          return unmappedBookingStatus('lodgify', raw || '(empty)')
  }
}

/**
 * Lodgify source -> booking_source enum.
 *
 * Substring matching over both `source` and `source_text` because the two
 * spell the same channel differently ('Airbnb' vs 'Airbnb (API)'), and
 * Lodgify's channel list is wider than the enum — Agoda, Expedia and the
 * direct booking engine have no member, so they land on 'other'. That is what
 * 'other' is for, not a mapping failure.
 */
export function mapLodgifySource(booking: LodgifyBooking): NormalizedBooking['source'] {
  const raw = `${booking.source ?? ''} ${booking.source_text ?? ''}`.toLowerCase()

  if (!raw.trim())                                    return 'other'
  if (raw.includes('airbnb'))                         return 'airbnb'
  if (raw.includes('vrbo') || raw.includes('homeaway')) return 'vrbo'
  if (raw.includes('booking.com') || raw.includes('booking_com')) return 'booking_com'
  if (raw.includes('manual'))                         return 'manual'
  if (raw.includes('direct') || raw.includes('website')) return 'direct'
  return 'other'
}

/**
 * A booking Lodgify has trashed or cancelled outright.
 *
 * Checked SEPARATELY from the status field and allowed to override it,
 * because a trashed booking can retain whatever status it held when it was
 * trashed. Treating it as still-booked would keep a cancelled stay on the
 * calendar and keep dispatching its turnover.
 */
function isCancelled(booking: LodgifyBooking): boolean {
  return booking.is_deleted === true || Boolean(optionalText(booking.canceled_at))
}

/**
 * Maps a Lodgify booking into the shared NormalizedBooking shape.
 *
 * `actual_total_amount` is GROSS — what Lodgify reports as the booking total,
 * with no commission netted out of it. Hostaway's mapper nets a channel fee
 * because Hostaway publishes which of its two fee fields comes out of the host
 * payout; Lodgify's equivalent is unverified, and a subtraction in the wrong
 * direction understates an owner statement by money the owner never lost.
 * When the breakdown is confirmed, net it here — booking-events.ts already
 * prefers this figure over its nights * avg_nightly_rate estimate, so
 * improving it improves every owner ledger without touching another file.
 *
 * `revenue_known_zero` mirrors hostaway.mappers.ts's identical flag: it is
 * true ONLY for a genuinely parseable `total_amount: 0`, via
 * isGenuineZeroTotal — never for an absent, blank or non-numeric field, all of
 * which mean "Lodgify didn't tell us" rather than "Lodgify told us $0". The
 * distinction is load-bearing: reservation-pipeline.ts's revenue-eligibility
 * check is `status === 'confirmed' && stay_type === 'guest_stay' &&
 * !revenue_known_zero`. Leaving this flag permanently false — as this file
 * used to — marks a genuinely-free confirmed stay as eligible anyway, with a
 * null `actual_total_amount`; booking-events.ts then falls back to a
 * nights * avg_nightly_rate ESTIMATE and posts it to owner_transactions as if
 * it were real money. Setting the flag correctly is what lets a real $0 stay
 * post nothing instead.
 */
export function lodgifyBookingToNormalized(booking: LodgifyBooking): NormalizedBooking {
  const cancelled = isCancelled(booking)

  return {
    external_id:          String(booking.id),
    property_external_id: booking.property_id === null || booking.property_id === undefined
      ? null
      : String(booking.property_id),

    checkin_date:  optionalDate(booking.arrival),
    checkout_date: optionalDate(booking.departure),

    // Lodgify carries no per-booking check-in/out TIME in the shape we type;
    // null defers to the property's own times rather than inventing one.
    checkin_time:  null,
    checkout_time: null,

    status: cancelled ? 'cancelled' : mapLodgifyStatus(booking.status),

    guest_name:  optionalText(booking.guest?.name),
    guest_email: optionalText(booking.guest?.email),

    source: mapLodgifySource(booking),

    // Lodgify's calendar blocks live on its availability endpoints rather than
    // in the bookings list this reads, so nothing arriving here is a block.
    // Revisit alongside the calendar-block phase, not before.
    is_block: false,

    // Absence maps to a paying stay, the safe direction: a block mis-read as a
    // stay still produces a turnover, whereas a stay mis-read as a block drops
    // its revenue silently.
    stay_type: booking.is_owner_stay === true ? 'owner_stay' : 'guest_stay',

    actual_total_amount: optionalAmount(booking.total_amount),
    revenue_known_zero:  isGenuineZeroTotal(booking.total_amount),
  }
}
