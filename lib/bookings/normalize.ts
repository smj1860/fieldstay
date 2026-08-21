// Shared normalization type for provider booking/reservation syncs
// (Hospitable, OwnerRez, ...). Mirrors lib/properties/normalize.ts.
//
// org_id, property_id (the FieldStay UUID, resolved from
// property_external_id via a lookup against the properties table), and
// external_source are added by each sync's call site — they aren't part of
// the raw provider payload a pure mapper can produce.

import type { Enums } from '@/types/database'

export interface NormalizedBooking {
  external_id:           string
  property_external_id:  string | null
  checkin_date:          string | null
  checkout_date:         string | null
  checkin_time:          string | null
  checkout_time:         string | null
  // status/source are the bookings table's own enums, not free strings —
  // typing them as `string` here let every provider mapper widen the value,
  // and once widened nothing checked it again before the insert.
  status:                Enums<'booking_status'>
  guest_name:            string | null
  guest_email:           string | null
  source:                Enums<'booking_source'>
  is_block:              boolean
  // Distinguishes an owner's personal-use stay from a paying guest
  // reservation. Providers with no equivalent concept (OwnerRez, Uplisting,
  // iCal) should map to 'guest_stay'.
  stay_type:             'guest_stay' | 'owner_stay'
  // Real total booking revenue reported by the PMS itself, when known —
  // preferred over the nights * avg_nightly_rate estimate that
  // booking-events.ts otherwise falls back to. Providers with no such
  // field should map to null.
  actual_total_amount:   number | null
}

/**
 * Fallback for a booking-status value a provider mapper doesn't recognize.
 *
 * Still defaults to 'tentative' rather than 'confirmed' — an unforeseen status
 * should fail toward caution, since 'confirmed' schedules a real turnover and
 * dispatches crew.
 *
 * REPORTS, rather than only warning. This used to be a bare console.warn, and
 * that is precisely how the OwnerRez status mapper stayed broken: it matched
 * `'confirmed'`, a string OwnerRez has never sent (its vocabulary is
 * `active`/`canceled`/`pending`), so EVERY live reservation landed here and was
 * written as tentative. Production ran that way for weeks with 28 tentative
 * OwnerRez bookings and zero confirmed ones — no alert, because the only
 * signal was a warn line in a serverless log nobody greps.
 *
 * A single unrecognized status is not noise: a provider's status vocabulary is
 * a closed set, so hitting this means the mapper disagrees with the provider,
 * and that disagreement applies to EVERY booking it touches, not one. Silently
 * degrading them all to tentative removes them from owner-ledger revenue,
 * pre-arrival guest email, gap-night offers, conflict detection and par
 * learning — all of which filter on 'confirmed' — while turnover generation
 * keeps working, so the integration still looks alive.
 */
export function unmappedBookingStatus(provider: string, rawStatus: string): 'tentative' {
  console.warn(`[${provider}] unrecognized booking status "${rawStatus}" — defaulting to tentative`)

  // Imported lazily so this module stays dependency-light for the pure mappers
  // that import it, and so a reporting failure can never break a sync.
  void import('@/lib/observability/report-error')
    .then(({ reportError }) => reportError(
      new Error(`[${provider}] unrecognized booking status "${rawStatus}" — defaulted to tentative`),
      { site: 'lib.bookings.normalize.unmappedBookingStatus' },
    ))
    .catch(() => { /* reporting must never fail a sync */ })

  return 'tentative'
}
