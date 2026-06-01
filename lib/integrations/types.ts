/**
 * Shared types for the FieldStay integration framework.
 */

export interface IntegrationProvider {
  id: string
  name: string
  description: string | null
  oauth_authorization_url: string
  oauth_token_url: string
  is_active: boolean
  created_at: string
}

export interface IntegrationConnection {
  id: string
  user_id: string
  org_id: string
  provider_id: string
  status: 'active' | 'error' | 'revoked'
  vault_secret_id: string | null
  external_user_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface OAuthTokenResponse {
  access_token: string
  token_type:   string
  scope:        string
  user_id:      number
}

export interface WebhookEvent {
  event_type:  string
  entity_type?: string
  entity_id?:  string | number
  [key: string]: unknown
}

// ── Typed errors ──────────────────────────────────────────────────────────────

export class TokenRevokedError extends Error {
  constructor(public readonly userId: string) {
    super(`[OwnerRez:${userId}] Access token has been revoked`)
    this.name = 'TokenRevokedError'
  }
}

export class RateLimitError extends Error {
  constructor(public readonly retryAfter: number) {
    super(`Rate limited — retry after ${retryAfter}s`)
    this.name = 'RateLimitError'
  }
}

// ── OwnerRez API shapes ───────────────────────────────────────────────────────

export interface OwnerRezProperty {
  id:           number
  name:         string
  bedrooms:     number
  bathrooms:    number
  max_occupancy: number
}

export interface OwnerRezGuest {
  id:    number
  name:  string | null
  email: string | null
}

export interface OwnerRezBooking {
  id:           number
  arrival:      string
  departure:    string
  status:       string
  channel_name?: string
  guest?: {
    name:  string | null
    email: string | null
  }
}

export interface OwnerRezUser {
  id:       number
  username: string
  email:    string | null
}

// ── Generic paged response shape ─────────────────────────────────────────────

export interface OwnerRezPagedResponse<T> {
  total_count:     number
  items:           T[]
  next_page_token?: string | null
}
