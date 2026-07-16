// lib/integrations/providers/hospitable.mappers.ts
// ============================================================
// Pure raw-Hospitable -> normalized-FieldStay mapping functions. Split out
// of hospitable.ts to keep that file focused on the OAuth adapter, webhook
// handling, and API fetch helpers. Re-exported from hospitable.ts as a
// barrel so existing consumers importing from
// '@/lib/integrations/providers/hospitable' are unaffected.
// ============================================================

import type { CrewRole } from '@/types/database'
import type { NormalizedProperty } from '@/lib/properties/normalize'
import type { NormalizedBooking } from '@/lib/bookings/normalize'
import { unmappedBookingStatus } from '@/lib/bookings/normalize'
import type {
  HospitableProperty,
  HospitableReservationStatus,
  HospitableReservation,
  HospitableTeammate,
  HospitableCrewMemberRow,
  HospitableCalendarDay,
  HospitableBlockRange,
} from './hospitable.types'

// Converts Hospitable's flat amenity slug array (e.g. ['ac', 'dishwasher'])
// into the Record<string, boolean> shape properties.amenities expects.
// Unlike OwnerRez's normalizeAmenities(), Hospitable's slugs are already
// clean snake_case — no title normalization needed.
export function normalizeHospitableAmenities(
  amenities: string[] | null
): Record<string, boolean> | null {
  if (!amenities?.length) return null
  return Object.fromEntries(amenities.map((a) => [a, true]))
}

// ✅ Confirmed live 2026-07-15 — see HospitableProperty.bookings' doc
// comment. Returns dollars (converts from integer cents), or null if the
// fee is absent or malformed in any way — never guesses a value from a
// partial match.
function extractHospitableCleaningFee(
  bookings: HospitableProperty['bookings']
): number | null {
  const fee = bookings?.fees?.find((f) => f.name === 'cleaning_fee')
  if (!fee || typeof fee.value !== 'object' || fee.value === null) return null

  const amount = fee.value.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null

  return Math.round(amount) / 100
}

// ✅ Confirmed live 2026-07-10 — see HospitableReservation.financials' doc
// comment. Tries each plausible key in priority order (host.revenue is
// what a PM/owner actually receives, which is the more useful and more
// likely-present figure for owner_transactions than a raw total the guest
// paid) and returns dollars for the first one that's present and
// well-formed, or null if none match — a wrong/absent guess falls back to
// the existing avg_nightly_rate estimate in booking-events.ts, never a
// fabricated number.
function extractHospitableActualTotal(
  financials: HospitableReservation['financials']
): number | null {
  if (!financials) return null

  // host.revenue ("Gross Revenue") is what actually matters for
  // owner_transactions; guest.total_price is a fallback only — it's what
  // the guest paid overall, which can include host-passthrough fees/taxes
  // that don't belong in a revenue figure, but is still a real number
  // rather than nothing if revenue itself is ever absent.
  for (const value of [financials.host?.revenue, financials.guest?.total_price]) {
    if (!value || typeof value.amount !== 'number') continue
    if (!Number.isFinite(value.amount) || value.amount <= 0) continue
    return Math.round(value.amount) / 100
  }

  return null
}

/**
 * Maps a raw HospitableProperty into the shared NormalizedProperty shape
 * (see lib/properties/normalize.ts) for lib/properties/upsert-normalized.ts
 * to write. Pure function — no I/O, no org context (the writer supplies
 * org_id at write time).
 */
export function hospitablePropertyToNormalized(
  prop: HospitableProperty
): NormalizedProperty {
  const addr          = prop.address
  const addressParts  = [addr.number, addr.street].filter(Boolean)
  const addressStr    = addressParts.join(' ') || null
  // ?? only falls through on null/undefined, not 0 — if capacity.bedrooms
  // is null and no bedroom-type room_details exist, .length is 0 (not
  // null), so a trailing `?? 1` would never fire. Using `|| 1` on the
  // room_details fallback specifically ensures "found zero bedroom rooms"
  // (an unknown-data signal) still defaults to 1, while a genuine
  // capacity.bedrooms of 0 (e.g. a true studio) is preserved as-is.
  const bedroomCount  = prop.capacity.bedrooms
    ?? (prop.room_details.filter((r) => r.type === 'bedroom').length || 1)

  return {
    external_id: prop.id,
    name:        prop.public_name || prop.name,
    address:     addressStr,
    city:        addr.city ?? null,
    state:       addr.state ?? null,
    zip:         addr.postcode ?? null,
    bedrooms:    bedroomCount,
    bathrooms:   prop.capacity.bathrooms ?? 1,
    max_guests:  prop.capacity.max ?? 2,
    checkin_time:  prop.checkin  ?? '15:00',
    checkout_time: prop.checkout ?? '11:00',
    // prop.timezone is a UTC offset (e.g. "-0500"), not an IANA identifier.
    // Derive from property state for DST-correct Intl compatibility.
    timezone: resolveHospitableTimezone(prop.timezone, addr.state),
    amenities:       normalizeHospitableAmenities(prop.amenities),
    smoking_allowed: prop.house_rules?.smoking_allowed ?? null,
    pets_allowed:    prop.house_rules?.pets_allowed    ?? null,
    events_allowed:  prop.house_rules?.events_allowed  ?? null,

    // Content fields — also always overwritten; see lib/properties/
    // upsert-normalized.ts's logContentOverwrites() for the audit trail
    // written before a real existing value is replaced.
    wifi_name:           prop.details?.wifi_name     || null,
    wifi_password:       prop.details?.wifi_password || null,
    access_instructions: prop.details?.guest_access  || null,
    house_manual:        prop.details?.house_manual  || null,

    cleaning_cost: extractHospitableCleaningFee(prop.bookings),
  }
}

// ── Status mapping ────────────────────────────────────────────────────────────

export function mapHospitableStatus(
  category: HospitableReservationStatus['category']
): 'confirmed' | 'tentative' | 'cancelled' {
  switch (category) {
    case 'accepted':      return 'confirmed'
    // 'unknown' and 'checkpoint' are documented, legitimate Hospitable
    // categories (not unforeseen values) — an in-flight/ambiguous
    // reservation should map to 'tentative' explicitly, same as 'request',
    // rather than being lumped into the same default branch that also
    // catches genuinely unrecognized values.
    case 'request':
    case 'unknown':
    case 'checkpoint':    return 'tentative'
    case 'cancelled':
    case 'not accepted':  return 'cancelled'
    default:              return unmappedBookingStatus('hospitable', category)
  }
}

// Confirmed Hospitable channel platform keys: airbnb | homeaway | booking | agoda | ical | manual | direct
export function mapHospitableChannel(
  platform: string
): 'airbnb' | 'vrbo' | 'booking_com' | 'direct' | 'other' {
  const p = platform.toLowerCase()
  if (p === 'airbnb')                   return 'airbnb'
  if (p === 'homeaway')                 return 'vrbo'
  if (p === 'booking')                  return 'booking_com'
  if (p === 'direct' || p === 'manual') return 'direct'
  return 'other'
}

/**
 * Pure raw -> NormalizedBooking mapper for a Hospitable reservation.
 * Extracted from the previously-duplicated inline row-building logic in
 * hospitable/initial-sync.ts and hospitable/incremental-sync.ts —
 * consolidated here as the single source of truth, mirroring
 * hospitablePropertyToNormalized above.
 *
 * Fixes a gap found while extracting this: guest.email is available on
 * every reservation fetched with include=guest (see HospitableGuest),
 * but the inline code only ever captured guest_name, never guest_email.
 * Both call sites already request include=guest, so this is populated
 * for free with no additional API cost.
 */
export function hospitableReservationToNormalized(
  res: HospitableReservation
): NormalizedBooking {
  // res.guest (singular) = GuestInfo (name/email/phone), only present when
  // include=guest. res.guests (plural) = GuestCounts — not name data.
  const guest     = res.guest ?? null
  const guestName = guest
    ? [guest.first_name, guest.last_name].filter(Boolean).join(' ') || null
    : null

  return {
    external_id: res.id,
    // Confirmed from the official Hospitable webhook spec: 'properties' is
    // an array[Property], not a singular 'property' object.
    property_external_id: res.properties?.[0]?.id ?? null,

    // arrival_date / departure_date are ISO datetimes at midnight — extract
    // the date portion. check_in / check_out carry the actual time of day.
    checkin_date:  res.arrival_date?.split('T')[0]   ?? null,
    checkout_date: res.departure_date?.split('T')[0] ?? null,
    checkin_time:  extractHospitableTime(res.check_in,  '15:00'),
    checkout_time: extractHospitableTime(res.check_out, '11:00'),

    // Confirmed 2026-07-10: a manual block never appears through this
    // endpoint at all — Hospitable's reservation_status.current.category
    // enum (request/accepted/cancelled/not accepted/unknown/checkpoint) has
    // no "blocked" value, and a real manually-blocked date range simply
    // never produces a reservation object here. is_block is correctly
    // false for every real /reservations response; the only place a block
    // ever surfaces is GET /properties/{uuid}/calendar (day-level, separate
    // from reservations entirely), handled by
    // lib/inngest/functions/hospitable/calendar-sync-handler.ts — see
    // consolidateHospitableBlocks() and
    // docs/Integrations/hospitable/api-reference.md's "Calendar /
    // Availability" section for the confirmed status.reason/source_type
    // signal it detects blocks from.
    status:      mapHospitableStatus(res.reservation_status.current.category),
    guest_name:  guestName,
    guest_email: guest?.email ?? null,
    source:      mapHospitableChannel(res.platform),
    is_block:    false,
    stay_type:   res.stay_type === 'owner_stay' ? 'owner_stay' : 'guest_stay',

    actual_total_amount: extractHospitableActualTotal(res.financials),
  }
}

// Maps Hospitable service labels to the FieldStay crew_role enum
// (cleaning | landscaping | maintenance | general — the enum has no
// crew/manager/owner values, so Check-in, Check-out, Concierge, Manager,
// Owner, and any unrecognized label all fall back to 'general'; the raw
// Hospitable labels are preserved separately in crew_members.specialty).
export function mapHospitableTeammateRole(
  services: Array<{ label: string }>
): CrewRole {
  const labels = services.map((s) => s.label.toLowerCase())

  if (labels.includes('maintenance')) return 'maintenance'
  if (labels.includes('cleaning'))    return 'cleaning'
  if (labels.includes('laundry'))     return 'cleaning'

  return 'general'
}

// Derives a display name from a Hospitable teammate record.
// Prefers the pre-combined `name` field; falls back to
// first_name + last_name construction; falls back to company_name.
export function resolveHospitableTeammateName(t: HospitableTeammate): string | null {
  if (t.name) return t.name
  if (t.first_name || t.last_name) {
    return [t.first_name, t.last_name].filter(Boolean).join(' ')
  }
  if (t.is_company && t.company_name) return t.company_name
  return null
}

/**
 * Maps raw HospitableTeammate records into crew_members upsert rows —
 * shared by hospitable/initial-sync.ts (first connect) and
 * hospitable/teammate-sync-handler.ts (daily resync) so both stay in sync
 * with the same role/specialty/name-resolution rules. Pure function — no
 * I/O; entries with no resolvable name are dropped (mirrors the original
 * initial-sync filtering).
 */
export function hospitableTeammatesToCrewRows(
  orgId:      string,
  teammates:  HospitableTeammate[]
): HospitableCrewMemberRow[] {
  return teammates
    .map((t) => ({ t, name: resolveHospitableTeammateName(t) }))
    .filter((entry): entry is { t: HospitableTeammate; name: string } =>
      entry.name !== null && entry.name.trim().length > 0
    )
    .map(({ t, name }) => ({
      org_id:            orgId,
      name,
      email:             t.email        ?? null,
      phone:             t.phone_number ?? null,
      role:              mapHospitableTeammateRole(t.services),
      is_active:         true,
      // reliability_score / capacity_score are 0–1 scale, NOT NULL — 1.0
      // matches the column DEFAULT and is a neutral starting score for
      // auto-assign-turnover's scoring algorithm.
      reliability_score: 1.0,
      capacity_score:    1.0,
      specialty:         t.services.length ? t.services.map((s) => s.label).join(', ') : null,
      external_id:       t.id,
      external_source:   'hospitable',
    }))
}

/**
 * Resolves an IANA timezone identifier for a Hospitable property.
 *
 * Hospitable's prop.timezone field returns a UTC offset string (e.g. "-0500")
 * not an IANA identifier. Node's Intl API requires IANA identifiers for DST-aware
 * timezone math — passing a raw UTC offset produces wrong results across DST
 * transitions (e.g. a Chicago property's "-0500" offset is only correct half the
 * year; in winter it's UTC-6).
 *
 * Strategy: derive timezone from the property's US state. State is stable, reliable,
 * and covers 99%+ of the US STR market without a geocoding API dependency.
 *
 * @param hospTimezone  Raw timezone value from Hospitable API (e.g. "-0500") —
 *                      intentionally not used; parameter exists for documentation
 * @param state         Two-letter US state code from the property address (e.g. "AL")
 * @returns             IANA timezone string safe for use with Intl.DateTimeFormat
 */
export function resolveHospitableTimezone(
  hospTimezone: string | null | undefined,
  state:        string | null | undefined
): string {
  const STATE_TIMEZONE: Record<string, string> = {
    // Eastern (UTC-5/UTC-4 DST)
    CT: 'America/New_York',  DE: 'America/New_York',  FL: 'America/New_York',
    GA: 'America/New_York',  MA: 'America/New_York',  MD: 'America/New_York',
    ME: 'America/New_York',  MI: 'America/Detroit',   NC: 'America/New_York',
    NH: 'America/New_York',  NJ: 'America/New_York',  NY: 'America/New_York',
    OH: 'America/New_York',  PA: 'America/New_York',  RI: 'America/New_York',
    SC: 'America/New_York',  VA: 'America/New_York',  VT: 'America/New_York',
    WV: 'America/New_York',
    // Indiana splits — use Indianapolis as the dominant zone
    IN: 'America/Indiana/Indianapolis',
    // Central (UTC-6/UTC-5 DST)
    AL: 'America/Chicago',   AR: 'America/Chicago',   IA: 'America/Chicago',
    IL: 'America/Chicago',   KS: 'America/Chicago',   KY: 'America/Chicago',
    LA: 'America/Chicago',   MN: 'America/Chicago',   MO: 'America/Chicago',
    MS: 'America/Chicago',   ND: 'America/Chicago',   NE: 'America/Chicago',
    OK: 'America/Chicago',   SD: 'America/Chicago',   TN: 'America/Chicago',
    TX: 'America/Chicago',   WI: 'America/Chicago',
    // Mountain (UTC-7/UTC-6 DST)
    CO: 'America/Denver',    MT: 'America/Denver',    NM: 'America/Denver',
    UT: 'America/Denver',    WY: 'America/Denver',
    // Mountain no-DST
    AZ: 'America/Phoenix',
    // Pacific (UTC-8/UTC-7 DST)
    CA: 'America/Los_Angeles', NV: 'America/Los_Angeles',
    OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
    // Non-contiguous
    AK: 'America/Anchorage',
    HI: 'Pacific/Honolulu',
    // Idaho splits — Boise (south) is most common for STR market
    ID: 'America/Boise',
  }

  const normalized = state?.trim().toUpperCase()
  if (normalized && STATE_TIMEZONE[normalized]) {
    return STATE_TIMEZONE[normalized]!
  }

  // Fallback — Central is the most common timezone in the US STR market
  // and is preferable to Eastern as a generic default for unknown states
  return 'America/Chicago'
}

// ── Utility ───────────────────────────────────────────────────────────────────

// Extracts "HH:MM" from a Hospitable ISO datetime string
// (e.g. "2019-01-03T13:00:00-05:00" → "13:00"). Falls back when
// the field is missing or doesn't match the expected shape.
export function extractHospitableTime(
  isoDatetime: string | null | undefined,
  fallback:    string
): string {
  const match = isoDatetime?.match(/T(\d{2}:\d{2})/)
  return match?.[1] ?? fallback
}

function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().split('T')[0]!
}

// A manually-blocked day is unavailable AND set by the PM, not a channel —
// confirmed live 2026-07-10 against a real block: {reason: "BLOCKED",
// source: null, source_type: "USER", available: false}. A real reservation
// covering the same property instead reports source_type: "RESERVATION",
// so the two are never confused without needing to cross-reference the
// bookings table at all. Consecutive blocked days are merged into a single
// range; checkout_date is the day after the last blocked night, matching
// every other provider's checkin/checkout semantics in this codebase.
export function consolidateHospitableBlocks(
  days: HospitableCalendarDay[]
): HospitableBlockRange[] {
  const ranges: HospitableBlockRange[] = []
  let rangeStart: string | null = null
  let lastBlockedDate: string | null = null

  const isManualBlock = (day: HospitableCalendarDay) =>
    !day.status.available && day.status.source_type === 'USER'

  const closeRange = () => {
    if (rangeStart && lastBlockedDate) {
      ranges.push({ checkin_date: rangeStart, checkout_date: addOneDay(lastBlockedDate) })
    }
    rangeStart = null
    lastBlockedDate = null
  }

  for (const day of days) {
    if (isManualBlock(day)) {
      if (!rangeStart) rangeStart = day.date
      lastBlockedDate = day.date
      continue
    }
    closeRange()
  }
  closeRange()

  return ranges
}
