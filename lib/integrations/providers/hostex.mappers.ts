// lib/integrations/providers/hostex.mappers.ts
// ============================================================================
// Pure raw-Hostex -> normalized-FieldStay mapping. No I/O, no org context —
// the writers supply org_id. Same split as hospitable.ts/hospitable.mappers.ts.
// ============================================================================

import type { NormalizedProperty } from '@/lib/properties/normalize'
import type { NormalizedBooking } from '@/lib/bookings/normalize'
import { unmappedBookingStatus } from '@/lib/bookings/normalize'
import { resolveHospitableTimezone } from '@/lib/integrations/providers/hospitable.mappers'
import type {
  HostexProperty,
  HostexReservation,
  HostexReservationStatus,
} from './hostex.types'

// ── Address ──────────────────────────────────────────────────────────────────

/**
 * Hostex gives ONE free-form `address` string — no structured city/state/zip.
 *
 * This pulls a US-style "…, City, ST 12345" tail off the end and returns the
 * remainder as the street. Anything that does not match that shape yields
 * nulls for city/state/zip and the whole string as the address, rather than a
 * guess: a mis-parsed state or ZIP is worse than an absent one, because zip
 * feeds geocoding and state feeds timezone resolution.
 */
export function parseHostexAddress(raw: string | null | undefined): {
  address: string | null
  city:    string | null
  state:   string | null
  zip:     string | null
} {
  const trimmed = raw?.trim()
  if (!trimmed) return { address: null, city: null, state: null, zip: null }

  // "<street…>, <city>, <ST> <ZIP>[-1234]" — the trailing country segment
  // Hostex sometimes appends (", United States") is tolerated and dropped.
  const withoutCountry = trimmed.replace(/,\s*(United States|USA|US)\s*$/i, '')
  const match = /^(.*),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/.exec(withoutCountry)

  if (!match) return { address: trimmed, city: null, state: null, zip: null }

  return {
    address: match[1]!.trim() || null,
    city:    match[2]!.trim() || null,
    state:   match[3]!,
    zip:     match[4]!,
  }
}

/** Hostex sends coordinates as strings; reject anything not a finite number. */
function parseCoordinate(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Maps a Hostex property into the shared NormalizedProperty shape.
 *
 * WHAT HOSTEX DOES NOT SEND, and what happens instead. /properties returns
 * only id, title, address, latitude, longitude, channels, groups and tags —
 * confirmed against the endpoint's full schema, and /room_types has no more.
 * So bedrooms, bathrooms, max_guests, check-in/out times and the amenity and
 * content fields have no source, and take FieldStay's own defaults for the PM
 * to correct. They are deliberately NOT guessed:
 *
 *   - bedrooms drives cleaning-cost estimates and checklist room seeding, so a
 *     fabricated count produces wrong money and wrong work, silently.
 *   - the four content fields (wifi_name, wifi_password, access_instructions,
 *     house_manual) are PM-EDITABLE and overwritten on every sync by
 *     upsert-normalized. Mapping them to null would wipe whatever the PM typed
 *     on every single sync. `undefined` is not an option either — the writer
 *     spreads them into the row. They are mapped to null here ONLY because
 *     Hostex genuinely has no such field, and upsert-normalized's
 *     logContentOverwrites() writes an audit_events row before replacing a
 *     real value, which is the recoverability trail for exactly this case.
 *     If Hostex ever exposes guest-facing content, map it here first.
 */
export function hostexPropertyToNormalized(prop: HostexProperty): NormalizedProperty {
  const addr = parseHostexAddress(prop.address)

  return {
    external_id: String(prop.id),
    name:        prop.title || `Hostex property ${prop.id}`,
    address:     addr.address,
    city:        addr.city,
    state:       addr.state,
    zip:         addr.zip,

    // Not exposed by Hostex — see the doc comment above.
    bedrooms:      1,
    bathrooms:     1,
    max_guests:    2,
    checkin_time:  '15:00',
    checkout_time: '11:00',

    // No IANA zone from Hostex either; derive from the parsed state, which is
    // the same fallback path hospitablePropertyToNormalized uses.
    timezone: resolveHospitableTimezone(null, addr.state),

    amenities:       null,
    smoking_allowed: null,
    pets_allowed:    null,
    events_allowed:  null,

    wifi_name:           null,
    wifi_password:       null,
    access_instructions: null,
    house_manual:        null,

    // Hostex DOES give exact coordinates, which is better than geocoding a
    // ZIP we may not even have parsed — see upsert-normalized's provider-
    // coordinate pass.
    lat: parseCoordinate(prop.latitude),
    lng: parseCoordinate(prop.longitude),
  }
}

// ── Reservations ─────────────────────────────────────────────────────────────

/**
 * Hostex status -> bookings.status.
 *
 * `accepted` is the only confirmed state. wait_accept/wait_pay are genuinely
 * in-flight and map to tentative. denied and timeout are requests that never
 * became stays; they collapse into 'cancelled' alongside real cancellations
 * because bookings.status has no "never accepted" value — the same known
 * ambiguity mapHospitableStatus documents for 'not accepted', recorded here
 * so it is not rediscovered as a bug.
 */
export function mapHostexStatus(status: HostexReservationStatus): NormalizedBooking['status'] {
  switch (status) {
    case 'accepted':                    return 'confirmed'
    case 'wait_accept':
    case 'wait_pay':                    return 'tentative'
    case 'cancelled':
    case 'denied':
    case 'timeout':                     return 'cancelled'
    default:                            return unmappedBookingStatus('hostex', status)
  }
}

/**
 * Hostex channel_type -> booking_source enum.
 *
 * Hostex's channel list is wider than the enum (agoda, expedia, trip.com and
 * custom channels have no member), so those land on 'other' — which is what
 * the enum's 'other' is for, not a mapping failure.
 */
export function mapHostexChannel(channelType: string | null | undefined): NormalizedBooking['source'] {
  const c = (channelType ?? '').toLowerCase()
  if (c === 'airbnb')                     return 'airbnb'
  if (c === 'vrbo' || c === 'homeaway')   return 'vrbo'
  if (c.startsWith('booking'))            return 'booking_com'
  if (c === 'direct' || c === 'manual')   return 'direct'
  return 'other'
}

/** "14:30" from Hostex's { hour, minute }, or the FieldStay default. */
function formatHostexTime(
  at:       { hour: number; minute: number } | null | undefined,
  fallback: string,
): string {
  if (!at || typeof at.hour !== 'number' || typeof at.minute !== 'number') return fallback
  if (at.hour < 0 || at.hour > 23 || at.minute < 0 || at.minute > 59)      return fallback
  return `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`
}

/**
 * The real money for this stay, in the account's currency.
 *
 * rates.total_rate is what the guest is charged; total_commission is the
 * channel's cut. The owner-facing figure is the difference, which is the same
 * choice hospitable's mapper makes in preferring host.revenue over
 * guest.total_price. Falls back to payment.total_amount, then to null — never
 * to a fabricated number, since booking-events.ts already has a documented
 * avg_nightly_rate estimate for the unknown case.
 *
 * Hostex amounts are already major units (decimal), NOT integer cents like
 * Hospitable's — no /100 here. Confirmed from the schema's `amount: number`
 * alongside a sibling `currency` string.
 */
export function extractHostexActualTotal(res: HostexReservation): number | null {
  const gross      = res.rates?.total_rate?.amount
  const commission = res.rates?.total_commission?.amount

  if (typeof gross === 'number' && Number.isFinite(gross) && gross > 0) {
    const net = typeof commission === 'number' && Number.isFinite(commission) && commission > 0
      ? gross - commission
      : gross
    if (net > 0) return net
  }

  const paid = res.payment?.total_amount
  if (typeof paid === 'number' && Number.isFinite(paid) && paid > 0) return paid

  return null
}

/**
 * Maps a Hostex reservation into the shared NormalizedBooking shape.
 *
 * external_id is `reservation_code` — Hostex reservations have no `id` field
 * at all, so there is no more obvious candidate to be wrong about.
 *
 * is_block is always false and stay_type always 'guest_stay': Hostex has no
 * owner-stay concept and no block ever appears through /reservations (blocks
 * live on the availability endpoints, which this phase does not sync).
 */
export function hostexReservationToNormalized(res: HostexReservation): NormalizedBooking {
  return {
    external_id:          res.reservation_code,
    property_external_id: res.property_id !== undefined && res.property_id !== null
      ? String(res.property_id)
      : null,

    checkin_date:  res.check_in_date  || null,
    checkout_date: res.check_out_date || null,
    checkin_time:  formatHostexTime(res.check_in_details?.arrival_at,   '15:00'),
    checkout_time: formatHostexTime(res.check_in_details?.departure_at, '11:00'),

    status:      mapHostexStatus(res.status),
    guest_name:  res.guest_name  ?? null,
    guest_email: res.guest_email ?? null,
    source:      mapHostexChannel(res.channel_type),
    is_block:    false,
    stay_type:   'guest_stay',

    actual_total_amount: extractHostexActualTotal(res),
  }
}
