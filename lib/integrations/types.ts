import type { Json } from '@/types/database'
import type { WebhookVerificationResult } from './webhook-verification'

export type ProviderAuthType = 'oauth2' | 'api_key'
export type ConnectionStatus = 'active' | 'revoked' | 'error' | 'disconnected'

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
  /**
   * Any non-sensitive provider-specific metadata to persist in the connection
   * row. `Json`, not `unknown` — it is written straight into a jsonb column.
   */
  metadata?: Record<string, Json>
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
   *
   * `refreshToken` is passed when one exists and the provider treats it as a
   * SEPARATELY revocable credential — Hostex does, and revoking only the
   * access token there would leave a live refresh token able to mint new ones
   * after the user has disconnected. A provider that revokes the whole grant
   * from either token (or has no refresh tokens at all, like OwnerRez) simply
   * ignores it.
   */
  revokeAccessToken?(params: {
    token:         string
    refreshToken?: string
  }): Promise<void>

  /**
   * Tear down provider-side state that outlives the token, BEFORE it is
   * revoked. Optional; implement only when there is such state.
   *
   * Revoking a token stops us calling THEM. It does not stop them calling US:
   * a provider that pushes to a per-connection URL keeps pushing to it after a
   * disconnect, and the registration can only be removed with a credential
   * that is about to be destroyed. Hence "before".
   *
   * Hostex is the current and only implementor — it registers an inbound
   * webhook per connection and exposes DELETE /webhooks/{id}. Without this the
   * PM disconnects, our route answers 401 to every delivery forever, and their
   * portal still lists a FieldStay webhook for an integration the operator
   * believes they removed.
   *
   * Best-effort by contract: the caller logs a failure and proceeds with local
   * teardown regardless. A provider-side registration we could not delete is a
   * wart; a disconnect that refuses to complete because of one is a live
   * credential the PM asked us to destroy and we did not.
   */
  cleanupBeforeRevoke?(params: {
    token:  string
    userId: string
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
  // ✅ Confirmed live 2026-07-15 against a real GET /v2/properties and
  // GET /v2/properties/{id} response: living_area (+ living_area_type,
  // e.g. "sq. ft.") is the real square-footage field. sqft/square_feet/size
  // were never real fields on this API — removed after confirming their
  // fallback chain always resolved to null on live data.
  living_area?:     number
  living_area_type?: string
  latitude?:        number  // confirmed field name
  longitude?:       number  // confirmed field name
  property_type?:   string
  // ✅ Confirmed live 2026-07-15 — this is a SINGLE object, not an array.
  // The previous `addresses?: OwnerRezPropertyAddress[]` shape meant
  // buildOwnerRezDetailPatch's `(detail.addresses ?? []).find(...)` always
  // read an empty array and never patched address/city/state/zip from any
  // property, on any org, ever.
  address?:         OwnerRezPropertyAddress
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
  // Effective 2026-07-07: 'owner' identifies an owner's own personal-use
  // stay — a full booking entity (has a guest_id/contact, can carry
  // charges), NOT a block, so is_block is false for these. Older values
  // (booking/block/quote_hold/linked_availability) predate this addition.
  type?:         'booking' | 'block' | 'quote_hold' | 'linked_availability' | 'owner'
  property_id?:  number
  channel_name?: string
  // ✅ Confirmed live 2026-07-15 against GET /v2/bookings with
  // include_guest=true — the real shape has first_name/last_name, NOT a
  // combined `name` field. This is why guest_name has been null on every
  // single OwnerRez booking ever synced, on every org — include_guest=true
  // itself was always the right param, but this field read it back wrong.
  // No `email` field was present on any sampled booking either; guest_id
  // is available for a future GET /v2/guests/{id} join if email is needed.
  guest?: {
    id?:         number
    first_name?: string | null
    last_name?:  string | null
  }
  // ✅ Confirmed live 2026-07-15 against GET /v2/bookings and
  // GET /v2/bookings/{id} — total_amount/total_owed are always present
  // (equal to each other on every sampled booking, all commission-free —
  // direct/referral channels). charges[] carries owner_amount per line
  // item, which is what's actually owed to the property owner net of any
  // PM commission (owner_commission_percent/owner_amount only diverge from
  // amount/total_amount when commission is nonzero — not yet observed
  // live). Only "rent" was seen as a charge type; other types (cleaning
  // fee, tax, etc.) are unconfirmed but assumed to sum the same way.
  total_amount?: number
  total_owed?:   number
  charges?: Array<{
    type:          string
    amount:        number
    owner_amount?: number
  }>
}

export interface OwnerRezUser {
  id:       number
  username: string
  email:    string
}

// ✅ Confirmed 2026-08-13 against OwnerRez's published OpenAPI 3.0 contract
// (https://api.ownerrez.com/openapi/v2.json → PageableEnumerableOf*, the
// wrapper returned by all 22 list endpoints).
//
// The previous shape guessed `total_count` and `next_page_token`. NEITHER
// name appears anywhere in that spec — zero occurrences of either string.
// The continuation field is `next_page_url`, so `next_page_token` read as
// undefined on every response and fetchAllPages' `while (nextPageToken)`
// exited after ONE page, with no `limit` sent so it took OwnerRez's default
// of 20. Live confirmation: the first OwnerRez sync for one production org
// created exactly 20 bookings in a single minute — the only burst of that
// size in the table. Silent: a 200, a well-formed body, no truncation signal.
export interface OwnerRezPagedResponse<T> {
  items:  T[]
  /** Records per page. Echoed back by OwnerRez; default 20, max 100. */
  limit?:  number
  /** Current offset from the start of the collection. */
  offset?: number
  /** Absolute URL of the next page. Null/absent means the collection is done. */
  next_page_url?: string | null
}

// ✅ Confirmed live 2026-07-15 against a real GET /v2/reviews response
// (submitted for "The Big Moose Lodge"). The previous shape guessed
// `rating` — a field that doesn't exist on this endpoint at all; since
// reviews.rating is NOT NULL, that would have failed every single
// OwnerRez review upsert outright, not just landed with a wrong value.
// guest_name is also a single display_name, NOT a first_name/last_name
// split (unlike OwnerRezBooking.guest, which is split).
export interface OwnerRezReview {
  id:            number
  stars:         number
  body?:         string | null
  title?:        string | null
  display_name?: string | null
  date?:         string   // stay/review date
  created_utc?:  string   // when the review record was created in OwnerRez
  property_id?:  number
  visible?:      boolean
  reviewer?:     string   // e.g. "guest"
}

// ── Error classes ─────────────────────────────────────────────────────────────

/**
 * WHY the credential could not be used. Same remediation, different diagnosis.
 *
 *   'no_stored_credential' — readIntegrationToken returned null. There is
 *                            nothing in Vault at all: the OAuth flow never
 *                            completed, the secret was deleted, or the row was
 *                            restored without it.
 *   'provider_rejected'    — the provider answered 401 to a credential we DO
 *                            hold. The grant was revoked on their side, or the
 *                            token expired with no refresh path.
 */
export type TokenRevokedReason = 'no_stored_credential' | 'provider_rejected'

/**
 * The credential cannot be used and only a reconnect will fix it.
 *
 * ── Why `reason` is required rather than defaulted ──────────────────────────
 *
 * Both cases used to raise the same sentence — "Access token revoked for user
 * X" — which is actively misleading for half of them: nothing was revoked when
 * the token was simply never stored. On 2026-08-18 three OwnerRez connections
 * reported exactly that while Vault held no secret for any of them, and the
 * message sent the investigation looking for a revocation on OwnerRez's side
 * that had never happened.
 *
 * The remediation is identical (reconnect), which is why this stays ONE error
 * class rather than two — every `instanceof TokenRevokedError` handler is still
 * correct and still needs no change. Only the diagnosis differs, so the
 * discriminator is a field. Required, so a new throw site must state which case
 * it is instead of inheriting whichever default happened to be chosen.
 */
export class TokenRevokedError extends Error {
  constructor(
    public readonly userId: string,
    public readonly reason: TokenRevokedReason,
  ) {
    super(
      reason === 'no_stored_credential'
        ? `No stored credential for user ${userId} — nothing in Vault to authenticate with; reconnect required`
        : `Access token rejected by provider for user ${userId} (401) — reconnect required`
    )
    this.name = 'TokenRevokedError'
  }
}

export class RateLimitError extends Error {
  constructor(public readonly retryAfter: number) {
    super(`Rate limited — retry after ${retryAfter}s`)
    this.name = 'RateLimitError'
  }
}

/**
 * A provider answered 401/403 on a data endpoint: the credential is not
 * entitled to what we asked for. TERMINAL — retrying cannot change the answer,
 * only a reconnect can.
 *
 * Distinct from TokenRevokedError, which means the whole grant is gone. This
 * one is per-ENDPOINT and its most common cause is a missing SCOPE: Hospitable
 * (and OwnerRez) configure scopes in the partner portal rather than in the
 * authorize URL, so a connection created before a scope was added keeps working
 * everywhere except the endpoints that scope covers. hospFetchTeammates already
 * open-coded exactly this case for 403 + teammate:read.
 *
 * Why it exists as a type rather than a string check: on 2026-08-17 a 401 from
 * GET /reservations/{uuid}/messages was thrown as a plain Error, so Inngest
 * burned all 5 retries on a call that could never succeed and then reported
 * "exhausted all retries" to Sentry. Five doomed calls against an API that was
 * ALREADY 429ing us (confirmed in Hospitable's own partner API log the same
 * hour) — the retry storm was feeding the rate limiting it was tangled up with.
 */
export class ProviderAuthError extends Error {
  constructor(
    public readonly providerLabel: string,
    public readonly status:        number,
    public readonly endpoint:      string,
    detail:                        string = '',
  ) {
    super(
      `${providerLabel} denied ${endpoint} (${status})` +
      (detail ? `: ${detail}` : '') +
      ' — the connection is missing a required scope or its access was revoked; reconnect required'
    )
    this.name = 'ProviderAuthError'
  }
}

/**
 * A provider rejected the REQUEST ITSELF as malformed — 400/422, not 401/403.
 * TERMINAL for the same reason ProviderAuthError is, but for the opposite
 * reason: the credential is fine, the bytes we sent are wrong, and the retry
 * sends the identical bytes.
 *
 * Why this is a separate type rather than folding 400 into ProviderAuthError:
 * the class name is what appears in Sentry and in system_job_runs, and
 * "denied ... reconnect required" would send the reader to the OAuth
 * connection for a bug that lives in our own URL construction. On 2026-08-20
 * that distinction was the whole finding — the connection was healthy.
 *
 * Retrying a 400 is not merely useless, it is actively harmful on a
 * rate-limited API: hospitable-incremental-sync burned 5 retries × 2
 * withProviderCall attempts on
 *   GET /reservations/1262483200/messages
 *   → {"reason_phrase":"Invalid resource uuid provided."}
 * holding one of the function's 8 concurrency slots for 10m41s per event,
 * twice, while spending the shared Hospitable API budget every attempt.
 */
export class ProviderRequestError extends Error {
  constructor(
    public readonly providerLabel: string,
    public readonly status:        number,
    public readonly endpoint:      string,
    detail:                        string = '',
  ) {
    super(
      `${providerLabel} rejected ${endpoint} as malformed (${status})` +
      (detail ? `: ${detail}` : '') +
      ' — the request we sent is wrong; retrying sends the same request'
    )
    this.name = 'ProviderRequestError'
  }
}

/**
 * Thrown when a provider adapter can't even attempt a call because our own
 * server-side credentials (CLIENT_ID/CLIENT_SECRET env vars) are missing —
 * an operational misconfiguration, never something the end user caused or
 * can fix by retrying. Kept distinct from a plain Error so callers that
 * surface provider-reported failure text to the user (e.g. the OAuth
 * callback route's /connect/error `detail` param) can exclude this case
 * rather than showing an internal config detail to an external visitor.
 */
export class IntegrationMisconfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IntegrationMisconfiguredError'
  }
}

// ── Sync error → PM-friendly message ────────────────────────────────────────
// Shared by all provider sync functions (OwnerRez, Hospitable — initial,
// incremental, reviews) so integration_connections.metadata.last_sync_error
// and the Settings UI show a consistent, actionable message regardless of
// which sync wrote it. Pass the provider's display name; defaults to
// 'OwnerRez' so existing call sites that don't pass one are unaffected.

/**
 * The TECHNICAL cause of a sync failure, for the connection row — alongside,
 * never instead of, translateSyncError's PM-facing sentence.
 *
 * translateSyncError falls through to "Sync failed — will retry automatically"
 * for anything it does not recognise, and that generic string used to be the
 * only record kept anywhere. Three OwnerRez connections sat in exactly that
 * state for three weeks (2026-08-18) and neither the row, the UI, nor a support
 * session could say what had actually failed.
 *
 * Truncated to 300 characters: enough to carry a status code and the head of a
 * provider response, short enough that a huge error body cannot bloat every
 * connection row.
 *
 * ⚠️ This lands in integration_connections.metadata, which staff read. Provider
 * error strings in this codebase are built from a status code plus a truncated
 * response body and never interpolate a credential — but if you add an adapter
 * that puts a token or a key in its Error message, it will arrive here. Mask it
 * at the throw site, not by dropping this field.
 */
export function syncErrorDetail(err: unknown): string {
  const raw = err instanceof Error
    ? `${err.name}: ${err.message}`
    : String(err)
  return raw.slice(0, 300)
}

export function translateSyncError(err: unknown, providerLabel: string = 'OwnerRez'): string {
  if (err instanceof RateLimitError) {
    return `${providerLabel} sync paused due to rate limiting — will retry automatically`
  }
  if (err instanceof TokenRevokedError) {
    return `${providerLabel} authorization expired — reconnect your account to resume syncing`
  }
  if (err instanceof ProviderAuthError) {
    // Named before the generic '401'/'403' substring checks below so the
    // endpoint-specific wording survives; those checks stay for the many
    // adapters still throwing plain Errors.
    return `${providerLabel} denied access to part of your account — reconnect your account to resume syncing`
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
