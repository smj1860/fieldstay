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
}
