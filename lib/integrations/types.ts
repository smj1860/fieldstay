import type { WebhookVerificationResult } from './webhook-verification'

export type ProviderAuthType = 'oauth2' | 'api_key'
export type ConnectionStatus = 'active' | 'revoked' | 'error'

/**
 * Normalized token response returned by every OAuth provider adapter.
 * Provider-specific raw responses are mapped to this shape inside each adapter.
 */
export interface TokenResponse {
  /** The access token to be stored in Vault */
  accessToken: string
  /** The provider's own user or account identifier */
  externalUserId: string
  /** Scopes granted (optional — not all providers return this) */
  scope?: string
  /** Any non-sensitive provider-specific metadata to persist in the connection row */
  metadata?: Record<string, unknown>
  /**
   * Refresh token, for providers whose access tokens expire (e.g. Kroger).
   * Stored in its own Vault secret via store_integration_refresh_token —
   * never persisted in `metadata` (plaintext jsonb).
   */
  refreshToken?: string
  /** ISO timestamp when accessToken expires. Omit for non-expiring tokens. */
  expiresAt?: string
}

/**
 * The contract every integration provider adapter must satisfy.
 * OAuth2 providers implement the oauth-prefixed methods.
 * API-key providers can skip them and implement getApiHeaders directly.
 */
export interface IntegrationProvider {
  /** Matches integration_providers.id in the database */
  readonly id: string
  readonly displayName: string
  readonly authType: ProviderAuthType

  // ── OAuth 2.0 methods (required when authType === 'oauth2') ──────────────

  /**
   * Build the full authorization URL to redirect the user to.
   * Called by the /connect route handler.
   */
  getAuthorizationUrl?(params: {
    state: string
    redirectUri: string
  }): string

  /**
   * Exchange a temporary authorization code for an access token.
   * Called by the /callback route handler immediately after the redirect.
   */
  exchangeCodeForToken?(params: {
    code: string
    redirectUri: string
  }): Promise<TokenResponse>

  /**
   * Refresh an expired access token using a refresh token.
   * OwnerRez does NOT support this — tokens are long-lived and never expire.
   * Implement this for providers that do (e.g. Guesty, Hostaway).
   */
  refreshAccessToken?(params: {
    refreshToken: string
  }): Promise<TokenResponse>

  /**
   * Revoke an access token on the provider's side.
   * Called when a user disconnects FieldStay from within our app.
   * The caller is responsible for also deleting the token from Vault.
   */
  revokeAccessToken?(params: {
    token: string
  }): Promise<void>

  // ── Universal methods (all providers) ───────────────────────────────────

  /**
   * Return the HTTP headers required to authenticate API calls to this provider.
   * Includes Authorization, User-Agent, Content-Type, etc.
   */
  getApiHeaders(token: string): Record<string, string>

  /**
   * Validate an incoming webhook request from this provider.
   * Each provider uses a different auth scheme (Basic Auth, HMAC, etc.) — see
   * lib/integrations/webhook-verification.ts for the shared result shape and
   * timestamp-freshness helper used where a provider's scheme supports one.
   */
  validateWebhook(request: Request): Promise<WebhookVerificationResult>

  /**
   * Process a validated webhook event payload.
   * Generic revocation events are handled centrally by the route handler.
   * Implement this for provider-specific event types (bookings, guests, etc.)
   */
  handleWebhookEvent(params: {
    action:          string
    payload:         unknown
    externalUserId:  string
    correlationId?:  string
  }): Promise<void>
}

// ── OwnerRez API response shapes ─────────────────────────────────────────────

export interface OwnerRezPropertyAddress {
  street1:     string
  city?:       string
  state:       string
  postal_code: string
  is_default:  boolean
}

export interface OwnerRezProperty {
  id:               number
  name:             string
  key?:             string   // UUID key for this property
  bedrooms:         number
  bathrooms:        number
  bathrooms_full?:  number
  bathrooms_half?:  number
  max_occupancy:    number   // returned by the /v2/properties LIST endpoint
  max_guests?:      number   // confirmed — returned by the /v2/properties/{id} DETAIL endpoint
  max_adults?:      number
  max_children?:    number
  max_pets?:        number
  living_area?:     number
  living_area_type?: string
  sqft?:            number
  square_feet?:     number
  size?:            number
  latitude?:        number  // confirmed field name
  longitude?:       number  // confirmed field name
  property_type?:   string
  addresses?:       OwnerRezPropertyAddress[]  // nested array, not flat fields
  check_in?:        string
  check_out?:       string
  is_snoozed?:      boolean

  // Rules — TODO: verify these field names with Paul or via propertysearch filter.
  // The propertysearch endpoint accepts pets_allowed and children_allowed as
  // filters but their presence on the detail endpoint is unconfirmed.
  smoking_allowed?: boolean | null
  pets_allowed?:    boolean | null
  events_allowed?:  boolean | null
  min_renter_age?:  number | null
}

// ── OwnerRez Listings endpoint ───────────────────────────────────────────────
// WiFi, guest instructions, house manual, and amenities all live here —
// NOT on the property detail endpoint above.

export interface OwnerRezListingAmenity {
  icon:  string
  text:  string
  title: string  // human-readable name e.g. "Hot Tub", "Fire Pit", "Private Pool"
}

export interface OwnerRezListingAmenityCategory {
  type:      string  // category type e.g. "pool_and_spa", "outdoor_features"
  caption:   string  // human-readable category name
  amenities: OwnerRezListingAmenity[]
}

export interface OwnerRezListing {
  property_id:           number
  wifi_network:          string | null   // NOTE: field is wifi_network, not wifi_name
  wifi_password:         string | null
  check_in_instructions: string | null
  house_manual:          string | null
  internet_info:         string | null
  directions:            string | null
  occupancy_max:         number | null
  sleeps_max:            number | null
  amenity_categories:    OwnerRezListingAmenityCategory[]  // nested, not flat
  amenity_call_outs:     OwnerRezListingAmenity[]
}

export interface OwnerRezGuest {
  id:    number
  name:  string | null
  email: string | null
}

export interface OwnerRezBooking {
  id:            number
  arrival:       string
  departure:     string
  status:        string
  is_block?:     boolean
  property_id?:  number
  channel_name?: string
  guest?: {
    name:  string | null
    email: string | null
  }
}

export interface OwnerRezUser {
  id:       number
  username: string
  email:    string
}

export interface OwnerRezPagedResponse<T> {
  total_count:     number
  items:           T[]
  next_page_token?: string | null
}

export interface OwnerRezReview {
  id:            number
  rating:        number
  comments?:     string
  body?:         string
  review_text?:  string
  guest_name?:   string
  guest?: { name?: string }
  created_at?:   string
  submitted_at?: string
  property_id?:  number
}

// ── Error classes ─────────────────────────────────────────────────────────────

export class TokenRevokedError extends Error {
  constructor(public readonly userId: string) {
    super(`Access token revoked for user ${userId}`)
    this.name = 'TokenRevokedError'
  }
}

export class RateLimitError extends Error {
  constructor(public readonly retryAfter: number) {
    super(`Rate limited — retry after ${retryAfter}s`)
    this.name = 'RateLimitError'
  }
}

// ── Sync error → PM-friendly message ────────────────────────────────────────
// Shared by all provider sync functions (OwnerRez, Hospitable — initial,
// incremental, reviews) so integration_connections.metadata.last_sync_error
// and the Settings UI show a consistent, actionable message regardless of
// which sync wrote it. Pass the provider's display name; defaults to
// 'OwnerRez' so existing call sites that don't pass one are unaffected.

export function translateSyncError(err: unknown, providerLabel: string = 'OwnerRez'): string {
  if (err instanceof RateLimitError) {
    return `${providerLabel} sync paused due to rate limiting — will retry automatically`
  }
  if (err instanceof TokenRevokedError) {
    return `${providerLabel} authorization expired — reconnect your account to resume syncing`
  }
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid_token')) {
    return `${providerLabel} authorization expired — reconnect your account to resume syncing`
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return `${providerLabel} access denied — reconnect your account`
  }
  if (lower.includes('timeout') || lower.includes('econnreset') || lower.includes('network')) {
    return `Could not reach ${providerLabel} — sync will retry automatically`
  }
  if (lower.includes('vault') || lower.includes('credentials not found')) {
    return `${providerLabel} credentials not found — reconnect your account`
  }
  if (lower.includes('upsert') || lower.includes('insert') || lower.includes('database')) {
    return 'Sync completed with errors — some bookings may not have updated'
  }
  return 'Sync failed — will retry automatically'
}
