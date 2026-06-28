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
   * Returns true if the request is authentic and should be processed.
   * Each provider uses a different auth scheme (Basic Auth, HMAC, etc.)
   */
  validateWebhook(request: Request): Promise<boolean>

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

export interface OwnerRezProperty {
  id:            number
  name:          string
  bedrooms:      number
  bathrooms:     number
  max_occupancy: number
  sqft?:         number
  square_feet?:  number
  size?:         number

  // Address — returned on detail endpoint
  address?:      string | null  // TODO: verify field name
  city?:         string | null  // TODO: verify — may be nested in address object
  state?:        string | null  // TODO: verify
  zip?:          string | null
  latitude?:     number | null  // TODO: verify — may be 'lat'
  longitude?:    number | null  // TODO: verify — may be 'lng'

  // WiFi — returned on detail endpoint
  wifi_name?:     string | null  // TODO: verify field name
  wifi_password?: string | null  // TODO: verify field name

  // Guest instructions — returned on detail endpoint
  // TODO: verify all field names against actual API response
  check_in_instructions?:  string | null
  check_out_instructions?: string | null
  house_manual?:           string | null
  door_code?:              string | null  // static property-level code if set

  // Rules — returned on detail endpoint
  // TODO: verify field names and nesting structure
  smoking_allowed?: boolean | null
  pets_allowed?:    boolean | null
  max_pets?:        number | null
  events_allowed?:  boolean | null
  min_renter_age?:  number | null

  // Amenities — returned as object or array on detail endpoint
  // TODO: verify shape — may be { amenity_name: boolean } or [{ id, value }]
  amenities?: Record<string, boolean> | null
}

// ── OwnerRez Listings endpoint (Addendum: used for batch amenity sync) ──────

export interface OwnerRezListingAmenity {
  amenity_id: string   // e.g. "hot_tub", "fire_pit", "private_pool"
  name:       string   // human-readable name
  available:  boolean  // TODO: verify field name — may be 'value' or 'enabled'
}

export interface OwnerRezListing {
  id:          number    // matches property external_id
  property_id: number
  name?:       string
  amenities?:  OwnerRezListingAmenity[]
  // TODO: add other listing fields after verifying actual API response shape
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
// Shared by all OwnerRez sync functions (initial, incremental, reviews) so
// integration_connections.metadata.last_sync_error and the Settings UI show
// a consistent, actionable message regardless of which sync wrote it.

export function translateSyncError(err: unknown): string {
  if (err instanceof RateLimitError) {
    return 'OwnerRez sync paused due to rate limiting — will retry automatically'
  }
  if (err instanceof TokenRevokedError) {
    return 'OwnerRez authorization expired — reconnect your account to resume syncing'
  }
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid_token')) {
    return 'OwnerRez authorization expired — reconnect your account to resume syncing'
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return 'OwnerRez access denied — reconnect your account'
  }
  if (lower.includes('timeout') || lower.includes('econnreset') || lower.includes('network')) {
    return 'Could not reach OwnerRez — sync will retry automatically'
  }
  if (lower.includes('vault') || lower.includes('credentials not found')) {
    return 'OwnerRez credentials not found — reconnect your account'
  }
  if (lower.includes('upsert') || lower.includes('insert') || lower.includes('database')) {
    return 'Sync completed with errors — some bookings may not have updated'
  }
  return 'Sync failed — will retry automatically'
}
