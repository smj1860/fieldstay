// lib/integrations/providers/hostex.types.ts
// ============================================================================
// Hostex API response shapes — Phase 1 subset only (OAuth + the minimal
// Property shape needed to derive a proxy externalUserId; see hostex.ts).
//
// Full Reservation/Transaction/Review/Task shapes deferred to Phase 3 (sync
// functions), where they'll be added alongside the mapper functions that
// consume them — following the same file-organization pattern as
// hospitable.types.ts / hospitable.mappers.ts.
// ============================================================================

// Every Hostex v3 response wraps its payload in this envelope. HTTP status is
// ALWAYS 200, even for errors — branch on error_code, never on response.ok
// alone for Hostex specifically (unlike Hospitable, which uses real HTTP
// status codes). error_code: 0 means success.
export interface HostexEnvelope<T> {
  request_id: string
  error_code: number
  error_msg:  string
  data:       T
}

export interface HostexTokenData {
  access_token:  string
  refresh_token: string
  expires_in:    number
  token_type?:   string
}

// ✅ Confirmed against api-doc.hostex.io/reference/query-properties.
//
// This IS the full property schema — Hostex's /properties returns nothing
// else. Note what is absent, because it shapes the mapper: no bedrooms, no
// bathrooms, no max occupancy, no check-in/check-out times, no amenities, no
// WiFi/house-manual content. /room_types was checked as an alternative source
// and has none of it either (it groups interchangeable properties for
// inventory selling; each entry carries only id + title). So those fields are
// FieldStay defaults on import and the PM edits them, rather than being
// silently wrong from a guess.
//
// latitude/longitude are STRINGS in Hostex's schema, not numbers.
export interface HostexProperty {
  id:         number
  title:      string
  address?:   string | null
  latitude?:  string | null
  longitude?: string | null
  channels?:  HostexPropertyChannel[]
  groups?:    Array<{ id: number; name: string }>
  tags?:      Array<{ id: number; name: string; color?: string }>
}

export interface HostexPropertyChannel {
  channel_type: string
  listing_id:   string
  currency?:    string
}

export interface HostexPropertiesData {
  properties: HostexProperty[]
  total:      number
}

// ── Reservations ─────────────────────────────────────────────────────────────
// ✅ Confirmed against api-doc.hostex.io/reference/query-reservations.
//
// There is no `id` field. `reservation_code` is the reservation's identity and
// is what external_id is keyed on. Only the fields the sync actually reads are
// modelled; the endpoint also returns check_in_details (incl. lock_code),
// guests[] with ID-document data, custom_fields and checkin_guide_images,
// none of which FieldStay stores — deliberately left off rather than typed and
// ignored, since lock codes and guest ID numbers are exactly the data this
// codebase must not casually pull into logs or rows.

/** Hostex's own reservation lifecycle enum, verbatim. */
export type HostexReservationStatus =
  | 'wait_accept'
  | 'wait_pay'
  | 'accepted'
  | 'cancelled'
  | 'denied'
  | 'timeout'

export interface HostexMoney {
  currency: string
  amount:   number
}

export interface HostexReservation {
  reservation_code:  string
  stay_code?:        string
  property_id:       number
  channel_id?:       string
  channel_type?:     string
  listing_id?:       string
  check_in_date:     string   // YYYY-MM-DD
  check_out_date:    string   // YYYY-MM-DD
  number_of_guests?: number
  status:            HostexReservationStatus
  guest_name?:       string | null
  guest_email?:      string | null
  cancelled_at?:     string | null
  booked_at?:        string
  created_at?:       string
  rates?: {
    total_rate?:       HostexMoney
    total_commission?: HostexMoney
    rate?:             HostexMoney
    commission?:       HostexMoney
    tax?:              HostexMoney | null
  }
  payment?: {
    currency:        string
    total_amount:    number
    received_amount: number
    balance_amount:  number
    status:          'unreceived' | 'partial' | 'received' | 'over_received'
  }
  check_in_details?: {
    arrival_at?:   { hour: number; minute: number } | null
    departure_at?: { hour: number; minute: number } | null
  }
}

export interface HostexReservationsData {
  reservations: HostexReservation[]
  total?:       number
}

// ── Webhooks ─────────────────────────────────────────────────────────────────
// ✅ Confirmed against the published OpenAPI for GET/POST /webhooks.

/** Every event Hostex can emit. FieldStay acts on the two reservation ones. */
export type HostexWebhookEvent =
  | 'reservation_created'
  | 'reservation_updated'
  | 'property_availability_updated'
  | 'listing_calendar_updated'
  | 'message_created'
  | 'review_created'
  | 'review_updated'
  | 'transaction_created'
  | 'transaction_updated'
  | 'transaction_deleted'

export interface HostexRegisteredWebhook {
  id:         number
  url:        string
  events:     HostexWebhookEvent[]
  /** Only a manageable webhook may be deleted by us. */
  manageable: boolean
  created_at: string
}

export interface HostexWebhooksData {
  webhooks: HostexRegisteredWebhook[]
}

/**
 * The inbound delivery body.
 *
 * A FLAT object — `event`, a few identifiers, and `timestamp`. There is no
 * nested `data`. Critically it is a PING, not a record: Hostex's own guidance
 * is that "the payload only confirms THAT the reservation changed", so the
 * handler must re-read the reservation from the API rather than infer state
 * from these fields.
 *
 * Typed loosely on purpose beyond the fields we use — Hostex explicitly warns
 * that payloads may gain parameters and that consumers must ignore unexpected
 * ones rather than reject the notification.
 */
export interface HostexWebhookPayload {
  event:             string
  /** Present on reservation_* events. The reservation's identity. */
  reservation_code?: string
  /** Multi-room bookings fire one event per stay: same code, distinct stay_code. */
  stay_code?:        string
  property_id?:      number
  /** reservation_updated only — names the kind of change (rates_updated, …). */
  sub_event?:        string
  timestamp?:        string
}
