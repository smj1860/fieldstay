// lib/integrations/providers/hospitable.types.ts
// ============================================================
// Type definitions for the Hospitable API. Split out of hospitable.ts to
// keep that file focused on the OAuth adapter, webhook handling, and API
// fetch helpers. Re-exported from hospitable.ts as a barrel so existing
// consumers importing from '@/lib/integrations/providers/hospitable' are
// unaffected.
// ============================================================

import type { CrewRole } from '@/types/database'

export interface HospitableUser {
  id:      string   // UUID
  email:   string
  name:    string
  company: string | null
}

export interface HospitableAddress {
  number:   string | null
  street:   string | null
  city:     string | null
  state:    string | null
  country:  string | null
  postcode: string | null
}

export interface HospitableProperty {
  id:            string   // UUID — use as external_id
  name:          string
  public_name:   string
  picture:       string | null   // ⚠️ Unconfirmed shape — may be an object (thumbnail/original), not yet inspected
  address:       HospitableAddress
  timezone:      string
  listed:        boolean

  // ✅ Confirmed live (2026-07-06) — real field names, NOT "check-in"/"check-out".
  // Prior code assumed hyphenated keys per the REST spec's example, which do
  // not exist in the actual response — every sync before this fix silently
  // fell back to the '15:00'/'11:00' defaults instead of the real times.
  checkin:  string   // "HH:MM"
  checkout: string   // "HH:MM"

  capacity: {
    max:       number | null
    bedrooms:  number | null
    beds:      number | null
    bathrooms: number | null   // ✅ Confirmed live via include=details
  }
  room_details: Array<{ type: string; beds: Array<{ type: string; quantity: number }> }>
  property_type: string
  room_type:     string

  // ── The following are populated by include=details.
  // ✅ Confirmed live (2026-07-06):
  amenities:   string[] | null   // e.g. ['ac', 'dishwasher', 'wireless_internet', ...]
  currency:    string   | null   // e.g. 'USD'
  description: string   | null   // '' (empty string) when unset, not null
  summary:     string   | null   // '' (empty string) when unset, not null
  house_rules: {
    pets_allowed:    boolean | null
    smoking_allowed: boolean | null
    events_allowed:  boolean | null
  } | null

  // ⚠️ Unconfirmed shape — present in the raw response, not yet inspected.
  tags:                string[] | null
  calendar_restricted: boolean  | null
  parent_child:        unknown  | null   // likely multi-unit/parent-listing linkage

  // ✅ Confirmed live (2026-07-06) — house_manual/wifi credentials are NOT
  // top-level fields despite include=details; they're nested under this
  // `details` object instead. Note the field is `wifi_name`, NOT
  // `wifi_network` as first assumed before live verification.
  //
  // wifi_password (and anything typed into house_manual, which often embeds
  // it as free text) is a credential, not property metadata — do NOT persist
  // it onto the `properties` table or any row a wider audience (e.g. the
  // owner portal) can select from. Route guest/crew-facing WiFi info through
  // guidebook_property_configs instead, which already exists for exactly
  // this purpose and is scoped by its own RLS policy. Never log wifi_name,
  // wifi_password, or house_manual — redact to presence/length only.
  details: {
    space_overview:            string | null
    guest_access:              string | null
    house_manual:              string | null
    other_details:             string | null
    additional_rules:          string | null
    neighborhood_description:  string | null
    getting_around:            string | null
    wifi_name:                 string | null
    wifi_password:             string | null
  } | null

  // ✅ Confirmed live 2026-07-15 — extractHospitableCleaningFee() reading
  // bookings.fees[name=cleaning_fee].value.amount correctly populated
  // properties.cleaning_cost for real synced properties (verified against
  // real DB rows: $35/$110/$135 across four different Hospitable
  // properties). Money values are integer cents (e.g. 12345 → "$123.45"),
  // matching every other monetary field Hospitable documents.
  bookings?: {
    fees?: Array<{
      name:  string   // e.g. 'cleaning_fee', 'managment_fee' (sic, per spec)
      type:  'fixed' | 'percent'
      value: number | { amount: number; formatted: string }
    }>
  } | null
}

export interface HospitableReservationStatus {
  category:     'request' | 'accepted' | 'cancelled' | 'not accepted' | 'unknown' | 'checkpoint'
  sub_category: string
}

export interface HospitableGuest {
  first_name:    string | null
  last_name:     string | null
  email:         string | null
  phone_numbers: string[] | null
}

export interface HospitableGuestCounts {
  total:        number
  adult_count:  number
  child_count:  number
  infant_count: number
  pet_count:    number
}

export interface HospitableReservation {
  id:               string   // UUID
  platform:         string   // 'airbnb' | 'homeaway' | 'booking' | 'direct' | ...
  platform_id:      string   // Channel-native confirmation code

  // All four fields are ISO datetime strings (format: date-time), NOT plain
  // date or time strings.
  //   arrival_date / departure_date — date portion only, at midnight:
  //     e.g. "2019-01-03T00:00:00-05:00" → extract date with .split('T')[0]
  //   check_in / check_out — the actual check-in/out time of day:
  //     e.g. "2019-01-03T13:00:00-05:00" → extract HH:MM with extractHospitableTime()
  arrival_date:     string
  departure_date:   string
  check_in:         string
  check_out:        string

  reservation_status: { current: HospitableReservationStatus }

  // guests = GuestCounts (adults, children, infants, pets) — always present.
  // guest  = GuestInfo (name, email, phone) — only present when include=guest.
  guests:  HospitableGuestCounts
  guest?:  HospitableGuest | null

  // properties = array[Property], populated when include=properties is passed.
  // Confirmed from the official Hospitable webhook spec — the response key
  // is plural (properties), matching the request param name. Use
  // properties?.[0]?.id, not a singular 'property' key.
  properties?: Array<{
    id:          string
    name:        string
    public_name: string
  }> | null

  // Distinguishes the property owner staying at their own listing from a
  // real paying guest reservation. owner_stay is only populated (and only
  // meaningful) when stay_type is 'owner_stay'.
  stay_type?: 'guest_stay' | 'owner_stay'
  owner_stay?: { schedule_cleaning: boolean } | null

  // ✅ Confirmed live 2026-07-10 — financials:read was granted (the
  // "not yet granted" status in earlier revisions of this comment was
  // stale, not the actual account state — see api-reference.md's scopes
  // table). A real test reservation's financials.host.revenue populated
  // bookings.actual_total_amount with the exact correct dollar amount and
  // flowed through to owner_transactions via extractHospitableActualTotal().
  financials?: {
    host?: {
      revenue?: HospitableMoneyValue   // label "Gross Revenue" — the figure that matters for owner_transactions
    }
    guest?: {
      total_price?: HospitableMoneyValue   // what the guest paid in total — includes fees/taxes the host doesn't keep
    }
    currency?: string
  } | null
}

// Common money-value shape used throughout Hospitable's API — integer
// cents + a pre-formatted display string, plus (on financials line items
// specifically) a label/category pair we don't currently use.
interface HospitableMoneyValue {
  amount:    number
  formatted: string
  label?:    string
  category?: string
}

export interface HospitableTeammate {
  id:             string         // UUID — use as external_id
  name:           string | null  // Full name (first_name + last_name combined)
  first_name:     string | null
  last_name:      string | null
  is_company:     boolean
  company_name:   string | null
  email:          string | null
  phone_number:   string | null  // Note: Hospitable uses phone_number, not phone
  all_services:   boolean
  all_properties: boolean
  services:       Array<{ id: number; label: string }>
}

export interface HospitablePagedTeammates {
  data: HospitableTeammate[]
  links: {
    next: string | null
    prev: string | null
  }
}

export interface HospitablePagedProperties {
  data:  HospitableProperty[]
  links: {
    first: string | null
    last:  string | null
    prev:  string | null
    next:  string | null
  }
}

export interface HospitablePagedReservations {
  data: HospitableReservation[]
  meta: {
    current_page: number
    last_page:    number
    per_page:     number
    total:        number
  }
}

// ✅ Confirmed live 2026-07-15 against a real GET /properties/{uuid}/reviews
// response (5 real reviews on a real property). With only include=guest
// requested, `reservation`/`property`/`listing` never appeared on any row —
// confirmed absent, not just undocumented — which is why
// hospitable-reviews-backfill.ts tags each row with the already-known
// FieldStay property_id from its own per-property fetch loop rather than
// reading review.property.id. `private` (feedback/detailed_ratings) is
// guest-submitted private feedback, not for public consumption — FieldStay
// never persists it; typed here only for documentation completeness.
export interface HospitableReview {
  id:            string
  platform:      'airbnb' | 'direct'
  reviewed_at:   string
  responded_at?: string | null
  can_respond?:  boolean
  public: {
    rating:                    number
    rating_platform_original?: string   // e.g. "5.00" — not consumed, typed for completeness
    review:                    string
    response?:                 string | null
  }
  private?: {
    feedback?:         string | null
    detailed_ratings?: Array<{ type: string; rating: number; comment?: string | null }>
  } | null
  guest?: {
    first_name?: string | null
    last_name?:  string | null
    language?:   string | null
  } | null
  reservation?: {
    id?:        string | null
    code?:      string | null
    check_in?:  string | null
    check_out?: string | null
  } | null
  property?: {
    id?:          string | null
    name?:        string | null
    public_name?: string | null
  } | null
  listing?: {
    platform?:    string | null
    platform_id?: string | null
  } | null
}

// ✅ Confirmed live 2026-07-15 — GET /properties/{uuid}/reviews returns BOTH
// a links cursor object and a meta page-count object; links.next is used
// for pagination here (same cursor style as
// hospFetchProperties/hospFetchTeammates) since it needs no extra
// page-counter bookkeeping.
export interface HospitablePagedReviews {
  data:  HospitableReview[]
  links?: {
    first: string | null
    last:  string | null
    prev:  string | null
    next:  string | null
  }
  meta?: {
    current_page: number
    last_page:    number
    per_page:     number
    total:        number
  }
}

// GET /reservations/{uuid}/messages — no per-message id in the documented
// response shape (only conversation_id/reservation_id at the message-list
// level), so callers derive their own dedup key from conversation_id +
// created_at + sender_type + a hash of body. attachments/reactions are
// typed loosely (unknown[]) — not consumed by FieldStay today, just
// preserved for a future UI.
export interface HospitableMessage {
  platform:          string
  platform_id:       number
  conversation_id:   string
  reservation_id:    string | null
  content_type:      string
  body:              string
  attachments:       unknown[] | null
  sender_type:       'host' | 'guest'
  sender_role:       string | null
  sender: {
    first_name:    string | null
    full_name:     string | null
    locale:        string | null
    picture_url:   string | null
    thumbnail_url: string | null
    location:      string | null
  } | null
  created_at:        string
  source:            string
  integration:       string | null
  sent_reference_id: string | null
}

export interface HospitablePagedMessages {
  data: HospitableMessage[]
}

export interface HospitableCalendarDayStatus {
  reason:      string
  source:      string | null
  source_type: string | null
  available:   boolean
}

export interface HospitableCalendarDay {
  date:                string
  day:                 string
  min_stay:            number
  note:                string | null
  closed_for_checkin:  boolean
  closed_for_checkout: boolean
  status:              HospitableCalendarDayStatus
  price:               { amount: number; currency: string; formatted: string }
}

export interface HospitableBlockRange {
  checkin_date:  string
  checkout_date: string
}

export interface HospitableCrewMemberRow {
  org_id:             string
  name:               string
  email:              string | null
  phone:              string | null
  role:               CrewRole
  is_active:          true
  specialty:          string | null
  reliability_score:  number
  capacity_score:     number
  external_id:        string
  external_source:    'hospitable'
}
