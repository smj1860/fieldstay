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

// ✅ Confirmed live against api-doc.hostex.io/reference/query-properties.
// Only the fields Phase 1 actually reads (id) plus a couple of
// obviously-useful ones for later phases — NOT the full property schema.
export interface HostexProperty {
  id:    number
  title: string
}

export interface HostexPropertiesData {
  properties: HostexProperty[]
  total:      number
}
