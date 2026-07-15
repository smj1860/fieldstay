// Shared normalization type for provider booking/reservation syncs
// (Hospitable, OwnerRez, ...). Mirrors lib/properties/normalize.ts.
//
// org_id, property_id (the FieldStay UUID, resolved from
// property_external_id via a lookup against the properties table), and
// external_source are added by each sync's call site — they aren't part of
// the raw provider payload a pure mapper can produce.

export interface NormalizedBooking {
  external_id:           string
  property_external_id:  string | null
  checkin_date:          string | null
  checkout_date:         string | null
  checkin_time:          string | null
  checkout_time:         string | null
  status:                string
  guest_name:            string | null
  guest_email:           string | null
  source:                string
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
 * Defaults to 'tentative' rather than 'confirmed' — an ambiguous/unforeseen
 * status should fail toward caution, since 'confirmed' is what schedules a
 * real turnover and dispatches crew.
 */
export function unmappedBookingStatus(provider: string, rawStatus: string): 'tentative' {
  console.warn(`[${provider}] unrecognized booking status "${rawStatus}" — defaulting to tentative`)
  return 'tentative'
}
