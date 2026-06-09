// src/lib/integrations/providers/ownerrez.ts
// ============================================================
// OwnerRez OAuth 2.0 provider adapter.
// Implements RFC 6749 Section 4.1 (Authorization Code Grant).
//
// OwnerRez specifics:
//   - Token exchange uses HTTP Basic Auth (NOT Bearer)
//   - Tokens are long-lived; there are NO refresh tokens
//   - Every API call must include a specific User-Agent header
//   - Webhook auth is HTTP Basic Auth (credentials you define)
//   - Revocation webhook body uses "action", not "event_type"
// ============================================================

import type { IntegrationProvider, TokenResponse } from '../types'

// ── Constants ────────────────────────────────────────────────────────────────

const OWNERREZ_AUTHORIZE_URL = 'https://app.ownerrez.com/oauth/authorize'
const OWNERREZ_TOKEN_URL     = 'https://api.ownerrez.com/oauth/access_token'
const OWNERREZ_API_BASE      = 'https://api.ownerrez.com'
const APP_VERSION            = '1.0'

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Base64-encodes "clientId:clientSecret" for HTTP Basic Auth.
 * Used for token exchange AND for revoking tokens.
 */
function buildBasicAuth(): string {
  const clientId     = process.env.OWNERREZ_CLIENT_ID
  const clientSecret = process.env.OWNERREZ_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing OWNERREZ_CLIENT_ID or OWNERREZ_CLIENT_SECRET environment variables'
    )
  }

  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
}

/**
 * The required User-Agent header for all OwnerRez API calls.
 * Format: "AppName/Version (ClientId)"
 * Failure to send this causes 403 errors from OwnerRez.
 */
function buildUserAgent(): string {
  const clientId = process.env.OWNERREZ_CLIENT_ID ?? 'unknown'
  return `FieldStay/${APP_VERSION} (${clientId})`
}

// ── Provider adapter ─────────────────────────────────────────────────────────

export const ownerRezProvider: IntegrationProvider = {
  id:          'ownerrez',
  displayName: 'OwnerRez',
  authType:    'oauth2',

  // Step 1: Build the URL the user is redirected to on OwnerRez
  getAuthorizationUrl({ state, redirectUri }) {
    const url = new URL(OWNERREZ_AUTHORIZE_URL)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id',     process.env.OWNERREZ_CLIENT_ID!)
    url.searchParams.set('redirect_uri',  redirectUri)
    url.searchParams.set('state',         state)
    return url.toString()
  },

  // Step 3: Exchange the temporary code for a long-lived access token
  async exchangeCodeForToken({ code, redirectUri }) {
    const response = await fetch(OWNERREZ_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${buildBasicAuth()}`,
        'User-Agent':    buildUserAgent(),
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: redirectUri,     // must match exactly what was sent in step 1
      }),
    })

    if (!response.ok) {
      let errorDetail = `HTTP ${response.status}`
      try {
        const body = await response.json() as { error?: string; error_description?: string }
        errorDetail = body.error_description ?? body.error ?? errorDetail
      } catch {
        // ignore JSON parse failure
      }
      throw new Error(`OwnerRez token exchange failed: ${errorDetail}`)
    }

    const data = await response.json() as {
      access_token: string
      token_type:   string
      scope:        string
      user_id:      number
    }

    return {
      accessToken:     data.access_token,
      externalUserId:  String(data.user_id),  // OwnerRez user_id as string
      scope:           data.scope,
    } satisfies TokenResponse
  },

  // NOTE: OwnerRez has NO refresh tokens. Tokens never expire unless revoked.
  // refreshAccessToken is intentionally NOT implemented.

  // Called when a FieldStay user disconnects OwnerRez from within our UI
  async revokeAccessToken({ token }) {
    const response = await fetch(`${OWNERREZ_API_BASE}/oauth/access_token/${token}`, {
      method:  'DELETE',
      headers: {
        'Authorization': `Basic ${buildBasicAuth()}`,
        'User-Agent':    buildUserAgent(),
      },
    })

    // 404 means the token was already invalid — treat as success
    if (!response.ok && response.status !== 404) {
      throw new Error(`OwnerRez token revocation failed: HTTP ${response.status}`)
    }
  },

  // Returns the headers needed for all OwnerRez API v2 calls
  getApiHeaders(token: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${token}`,
      'User-Agent':    buildUserAgent(),
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    }
  },

  // Validates incoming webhook requests from OwnerRez using HTTP Basic Auth.
  // Credentials (user + password) are ones YOU defined in the app registration.
  async validateWebhook(request: Request): Promise<boolean> {
    const authHeader = request.headers.get('Authorization')

    if (!authHeader?.startsWith('Basic ')) return false

    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8')
    const [user, pass] = decoded.split(':', 2)   // split on first colon only

    const expectedUser = process.env.OWNERREZ_WEBHOOK_USER
    const expectedPass = process.env.OWNERREZ_WEBHOOK_PASSWORD

    if (!expectedUser || !expectedPass) {
      throw new Error(
        'Missing OWNERREZ_WEBHOOK_USER or OWNERREZ_WEBHOOK_PASSWORD environment variables'
      )
    }

    // Constant-time comparison to prevent timing attacks
    const userMatch = timingSafeEqual(user, expectedUser)
    const passMatch = timingSafeEqual(pass, expectedPass)

    return userMatch && passMatch
  },

  // Handles OwnerRez-specific webhook events beyond the generic revocation.
  // The revocation event is handled centrally by the webhook route handler.
  async handleWebhookEvent({ action, payload, externalUserId }) {
    switch (action) {
      case 'application_authorization_revoked':
        // Handled by the generic webhook route — nothing to do here
        break

      // Future: entity change webhooks (booking.created, guest.updated, etc.)
      // These require setting up individual webhook subscriptions via:
      // POST /v2/webhooksubscriptions
      // See OwnerRez Webhooks documentation for the payload format.
      default: {
        // Never log raw payload — future events (booking.created, guest.updated)
        // will contain guest PII: name, email, phone. Log only safe fields.
        const safeLog = {
          action,
          external_id: typeof payload === 'object' && payload !== null
            ? (payload as Record<string, unknown>).id ?? null
            : null,
        }
        console.warn('[OwnerRez] Unhandled webhook action', safeLog)
      }
    }
  },
}

// ── Utility ──────────────────────────────────────────────────────────────────

/**
 * Constant-time string comparison to prevent timing-based credential attacks.
 * Regular === comparison leaks information about where strings differ.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}
