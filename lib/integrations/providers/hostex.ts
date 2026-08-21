// lib/integrations/providers/hostex.ts
// ============================================================================
// Hostex OAuth 2.0 provider adapter — PHASE 1 (OAuth connect/callback only).
//
// Hostex specifics:
//   - Full browser-redirect OAuth2 (authorization code grant)
//   - Authorize URL requires redirect_uri as an explicit query param (unlike
//     Hospitable, where it's portal-configured and NOT sent as a URL param)
//   - Token URL: POST https://api.hostex.io/v3/oauth/authorizations for BOTH
//     obtaining and refreshing (grant_type distinguishes them) — there is no
//     separate refresh endpoint the way some providers have
//   - Access tokens expire every 7 days (confirmed in Hostex's own
//     Authorization Workflow doc) — much longer than Hospitable's 12 hours
//   - API base: https://api.hostex.io/v3
//   - Every v3 response uses the envelope { request_id, error_code,
//     error_msg, data }, HTTP status ALWAYS 200 even on failure — branch on
//     error_code, not response.ok. That includes rate limiting: a throttled
//     request is HTTP 200 with error_code 429 and a Retry-After header.
//   - Auth header is 'Hostex-Access-Token', NOT 'Authorization: Bearer' —
//     confirmed from the OpenAPI securityScheme
//     ({ name: 'Hostex-Access-Token', in: 'header' }) that every v3 endpoint
//     declares. Phase 1 shipped Bearer on an assumption; every API call would
//     have 401'd, which was invisible only because the one Phase 1 call site
//     (deriveHostexExternalUserId) degrades to '' on failure by design.
//   - No account-identity endpoint exists (no /user, /me, /account
//     equivalent anywhere in the confirmed API surface) — externalUserId is
//     derived from the first property's id as a proxy; see
//     deriveHostexExternalUserId() below
//   - No webhook-driven revocation event exists. Hostex's webhook event list
//     is exactly reservation_created / reservation_updated /
//     property_availability_updated / listing_calendar_updated /
//     message_created / review_created / review_updated — there is no
//     authorization-revoked equivalent, so the generic webhook route's
//     REVOCATION_ACTIONS handling will never fire for Hostex. Connection
//     health can only be detected reactively, via a failed refresh (7-day
//     cycle) or a failed API call during sync. Expect Hostex disconnections
//     to surface days later than Hospitable/OwnerRez ones — an inherent
//     Hostex API limitation, not something to fix in code.
//   - Hostex webhooks do NOT go through the generic /api/webhooks/[provider]
//     route, so this adapter's validateWebhook/handleWebhookEvent are not the
//     live path. Hostex identifies the target account by a per-connection
//     token in the URL — see app/api/webhooks/hostex/[token]/route.ts and
//     hostex-webhook.ts. The two methods below stay as fail-closed rejections
//     because the IntegrationProvider interface requires them.
//   - The access and refresh tokens are SEPARATELY revocable, and
//     /oauth/revoke takes one per call — so revokeAccessToken below makes two.
//     Note this is the outbound direction only, and does not soften the
//     no-revocation-webhook limitation above: we can tell Hostex we are done,
//     but Hostex cannot tell us the host revoked us.
//
// Type definitions live in hostex.types.ts, re-exported below so
// `import { HostexProperty } from '@/lib/integrations/providers/hostex'`
// keeps working, matching the hospitable.ts/hospitable.types.ts convention.
// ============================================================================

import {
  IntegrationMisconfiguredError,
  type IntegrationProvider,
  type TokenResponse,
} from '@/lib/integrations/types'
import { fail, type WebhookVerificationResult } from '@/lib/integrations/webhook-verification'
import { PMS_API_TIMEOUT_MS } from '@/lib/http/timeout'
import { reportError } from '@/lib/observability/report-error'
import type { HostexEnvelope, HostexTokenData, HostexPropertiesData } from './hostex.types'

export * from './hostex.types'

// ── Constants ────────────────────────────────────────────────────────────────

const HOSTEX_AUTHORIZE_URL = 'https://hostex.io/app/authorization'
const HOSTEX_TOKEN_URL     = 'https://api.hostex.io/v3/oauth/authorizations'
// Distinct path from the token endpoint above — /oauth/revoke, not a DELETE
// against /oauth/authorizations.
const HOSTEX_REVOKE_URL    = 'https://api.hostex.io/v3/oauth/revoke'
const HOSTEX_API_BASE      = 'https://api.hostex.io/v3'

// Hostex's own Rate Limits doc explicitly recommends this: "helps Hostex
// bypass IP-level bot defences and lets the on-call team contact you about
// behaviour issues" — cheap to add, directly grounded in their docs.
const HOSTEX_USER_AGENT = 'FieldStay/1.0 (stephen@fieldstay.app)'

// Hostex's own OpenAPI securityScheme: { name: 'Hostex-Access-Token',
// in: 'header' }. Not an Authorization header, and not a Bearer scheme.
export const HOSTEX_AUTH_HEADER = 'Hostex-Access-Token'

/**
 * Which envelope error_code values mean success.
 *
 * RESOLVED 2026-08-21 against api-doc.hostex.io/reference/errors: it is ZERO.
 * "error_code: 0 means success. Any non-zero value is a failure." The complete
 * code table there is 0 / 400 / 401 / 403 / 404 / 409 / 420 / 422 / 429 / 500 /
 * 501 / 502 / 503 / 504 — 200 does not appear in it at all.
 *
 * This adapter previously accepted BOTH, because the OpenAPI schema's own
 * description for the field claims "A value of 200 indicates success" while
 * that same schema's `example` is 0. Their docs contradict themselves; the
 * Errors reference is the authority and the example agrees with it.
 *
 * Accepting both was never dangerous — no endpoint emits 200 as an error_code,
 * so the extra member was unreachable rather than wrong. But leaving it in
 * means a future Hostex code 200 with some new meaning would read as success,
 * which is the failure mode this narrowing removes.
 *
 * Not a blanket "any code is fine": a genuine failure code must still be
 * rejected, which is the entire point of branching on the envelope rather than
 * on response.ok.
 */
const HOSTEX_SUCCESS_CODE = 0

export function isHostexSuccess(errorCode: number): boolean {
  return errorCode === HOSTEX_SUCCESS_CODE
}

/** Hostex signals throttling in-band: HTTP 200, error_code 429, Retry-After. */
export const HOSTEX_RATE_LIMITED_CODE = 429

/**
 * A business-level rejection from Hostex's OAuth endpoint: HTTP 200 with a
 * non-zero `error_code` in the body.
 *
 * Typed rather than a bare Error because the token-refresh handler has to tell
 * "this grant is dead, stop retrying and tell the PM to reconnect" apart from
 * "the network blipped, retry". For every other provider that distinction is
 * carried by the HTTP status, and the handler classifies on a '400'/'401'
 * substring in the message. Hostex always answers 200, so that check would be
 * decided by whether the error_code's DIGITS happen to contain 400 — true for
 * 40001, false for 10002. An instanceof is not a coincidence.
 */
export class HostexOAuthError extends Error {
  constructor(public readonly errorCode: number, errorMsg: string) {
    super(`Hostex OAuth error ${errorCode}: ${errorMsg}`)
    this.name = 'HostexOAuthError'
  }
}

/** Both credentials or a typed misconfiguration — never a half-built request. */
function hostexCredentials(): { clientId: string; clientSecret: string } {
  const clientId     = process.env.HOSTEX_CLIENT_ID
  const clientSecret = process.env.HOSTEX_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new IntegrationMisconfiguredError('Missing HOSTEX_CLIENT_ID or HOSTEX_CLIENT_SECRET')
  }

  return { clientId, clientSecret }
}

// ── Token response parsing ──────────────────────────────────────────────────
//
// UNCONFIRMED whether the OAuth token endpoint follows the same
// { request_id, error_code, error_msg, data } envelope as every other v3
// endpoint, or returns a bare OAuth2-standard top-level body the way
// Hospitable does. Handles both; logs which branch fired so the dead one can
// be deleted once a real connect confirms the actual shape. Do not remove
// either branch without that confirmation.
function parseHostexTokenResponse(body: unknown): HostexTokenData {
  if (typeof body !== 'object' || body === null) {
    throw new Error(`Hostex token response was not a JSON object (got ${typeof body})`)
  }

  const obj = body as Record<string, unknown>

  // Branch 1: enveloped, matching every other confirmed Hostex v3 response.
  if (typeof obj.error_code === 'number') {
    const envelope = obj as unknown as HostexEnvelope<HostexTokenData>
    if (!isHostexSuccess(envelope.error_code)) {
      throw new HostexOAuthError(envelope.error_code, envelope.error_msg)
    }
    if (!envelope.data?.access_token) {
      throw new Error('Hostex token response (enveloped) missing data.access_token')
    }
    console.log('[Hostex] token response was enveloped ({request_id,error_code,...,data}) — this branch fired')
    return envelope.data
  }

  // Branch 2: bare top-level OAuth2-standard body.
  if (typeof obj.access_token === 'string') {
    console.log('[Hostex] token response was a bare top-level body (no envelope) — this branch fired')
    return obj as unknown as HostexTokenData
  }

  // Keys go to the log, not to the thrown message: 'hostex' is in the OAuth
  // callback's SAFE_DETAIL_PROVIDERS, so this message can reach an
  // unauthenticated visitor on /connect/error. Every other branch here throws
  // either a provider-parsed error_msg or a fixed string; this one used to
  // interpolate whatever key names Hostex happened to send.
  console.error(
    '[Hostex] token response matched neither known shape. Keys present:',
    Object.keys(obj).join(', '),
  )
  throw new Error('Hostex returned an unrecognized token response')
}

/**
 * POST the shared token endpoint and normalize the result. Obtain and refresh
 * differ only by the grant-specific body fields, so they share this — the
 * endpoint, headers, timeout budget, non-JSON handling and envelope parsing
 * are identical for both by Hostex's own design (grant_type is the only
 * discriminator).
 */
async function requestHostexToken(
  grantFields: Record<string, string>,
  label:       'exchange' | 'refresh',
): Promise<HostexTokenData> {
  const { clientId, clientSecret } = hostexCredentials()

  const response = await fetch(HOSTEX_TOKEN_URL, {
    signal: AbortSignal.timeout(PMS_API_TIMEOUT_MS),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'User-Agent':   HOSTEX_USER_AGENT,
    },
    // No redirect_uri here — confirmed absent from the documented body
    // params for this endpoint. Do not add it back without re-checking
    // https://api-doc.hostex.io/reference/obtain-token.
    body: JSON.stringify({
      client_id:     clientId,
      client_secret: clientSecret,
      ...grantFields,
    }),
  })

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`Hostex token ${label} returned non-JSON body: HTTP ${response.status}`)
  }

  return parseHostexTokenResponse(body)
}

/**
 * Revoke ONE Hostex token. Separate from requestHostexToken despite the shared
 * credential fields: this endpoint returns no token to parse, and routing it
 * through parseHostexTokenResponse would fail on a perfectly successful
 * revocation that carries only an envelope.
 *
 * A token Hostex no longer recognizes is a SUCCESS here, not a failure. The
 * common reason a user disconnects is that the connection already broke, and
 * treating "already gone" as an error would turn the expected case into a
 * reported one — the same reasoning as OwnerRez's 404 branch.
 */
async function revokeHostexToken(token: string): Promise<void> {
  const { clientId, clientSecret } = hostexCredentials()

  const response = await fetch(HOSTEX_REVOKE_URL, {
    signal: AbortSignal.timeout(PMS_API_TIMEOUT_MS),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'User-Agent':   HOSTEX_USER_AGENT,
    },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, token }),
  })

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`Hostex token revocation returned non-JSON body: HTTP ${response.status}`)
  }

  const envelope = body as { error_code?: number; error_msg?: string }
  const code     = envelope.error_code

  // The documented success example for THIS endpoint returns error_code 200
  // with error_msg "Done." — the same 0-or-200 ambiguity isHostexSuccess
  // exists for, so it is reused rather than re-decided here.
  if (code === undefined || isHostexSuccess(code)) return

  // 401 is "this token is not valid", which for a revocation is the outcome
  // we wanted. 404 likewise.
  if (code === 401 || code === 404) return

  throw new Error(`error_code ${code} — ${envelope.error_msg ?? 'no message'}`)
}

/** Shared shape for both grants: the token plus whatever expiry Hostex sent. */
function toTokenResponse(data: HostexTokenData, externalUserId: string): TokenResponse {
  const result: TokenResponse = {
    accessToken:    data.access_token,
    externalUserId,
    metadata:       {},
  }

  if (data.refresh_token) result.refreshToken = data.refresh_token
  if (data.expires_in)    result.expiresAt    = new Date(Date.now() + data.expires_in * 1000).toISOString()

  return result
}

// ── Derive a proxy external identity ────────────────────────────────────────
//
// Hostex has no "who am I" endpoint. externalUserId is required by
// TokenResponse, so this fetches the first property and uses its id as a
// stand-in. Known limits, stated rather than papered over:
//   - A brand-new Hostex account with zero properties at connect time has
//     nothing to derive from — falls back to '' (empty string), logged.
//   - This is a PROPERTY id, not an operator/account id. If that specific
//     property is ever deleted, this "identity" reference is stale. It is
//     NOT used for revocation-webhook matching (Hostex has none — see the
//     header comment) so staleness has no functional consequence today;
//     it exists only for the connection row's own record-keeping/audit
//     trail. Do not build revocation matching against this value later
//     without re-deriving it, since it was never designed to be stable.
//
// Never throws: a failure here must not fail an otherwise-successful connect.
async function deriveHostexExternalUserId(accessToken: string): Promise<string> {
  try {
    const res = await fetch(`${HOSTEX_API_BASE}/properties?limit=1`, {
      signal:  AbortSignal.timeout(PMS_API_TIMEOUT_MS),
      headers: hostexProvider.getApiHeaders(accessToken),
    })

    if (!res.ok) {
      console.warn(`[Hostex] properties fetch for externalUserId derivation failed: HTTP ${res.status}`)
      return ''
    }

    const envelope = await res.json() as HostexEnvelope<HostexPropertiesData>
    if (!isHostexSuccess(envelope.error_code)) {
      console.warn(`[Hostex] properties fetch for externalUserId derivation returned error_code ${envelope.error_code}: ${envelope.error_msg}`)
      return ''
    }

    const first = envelope.data?.properties?.[0]
    if (!first) {
      console.warn('[Hostex] account has zero properties at connect time — externalUserId will be empty')
      return ''
    }

    return String(first.id)
  } catch (err) {
    console.warn('[Hostex] externalUserId derivation threw — proceeding with empty externalUserId:', err)
    reportError(err, { site: 'lib.integrations.providers.hostex.deriveHostexExternalUserId' })
    return ''
  }
}

// ── Provider adapter ─────────────────────────────────────────────────────────

export const hostexProvider: IntegrationProvider = {
  id:          'hostex',
  displayName: 'Hostex',
  authType:    'oauth2',

  getAuthorizationUrl({ state, redirectUri }) {
    // Unlike Hospitable, Hostex requires redirect_uri as an explicit query
    // param on the authorization request — confirmed in Hostex's
    // Authorization Workflow doc.
    const { clientId } = hostexCredentials()
    const url = new URL(HOSTEX_AUTHORIZE_URL)
    url.searchParams.set('client_id',    clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    if (state) url.searchParams.set('state', state)
    return url.toString()
  },

  async exchangeCodeForToken({ code }): Promise<TokenResponse> {
    const data = await requestHostexToken(
      { grant_type: 'authorization_code', code },
      'exchange',
    )

    return toTokenResponse(data, await deriveHostexExternalUserId(data.access_token))
  },

  // Access tokens expire every 7 days. Same token endpoint as the initial
  // exchange, distinguished by grant_type. externalUserId is NOT re-derived
  // on refresh — already stored on the connection row from the initial
  // connect, same convention as hospitable.ts's refreshAccessToken.
  async refreshAccessToken({ refreshToken }): Promise<TokenResponse> {
    const data = await requestHostexToken(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      'refresh',
    )

    return toTokenResponse(data, '')
  },

  /**
   * POST /oauth/revoke — { client_id, client_secret, token }, all three
   * required (confirmed against api-doc.hostex.io/reference/revoke-token).
   *
   * REVOKES BOTH CREDENTIALS, one call each. The endpoint takes a single
   * `token` and Hostex issues the access and refresh tokens as separately
   * revocable secrets, so revoking only the access token would leave a live
   * refresh token — one that can mint fresh access tokens for an account the
   * user has just disconnected. The refresh token is the more dangerous of
   * the two to leave behind: it outlives the 7-day access token indefinitely.
   *
   * Best-effort per token. The caller (disconnectIntegration) already treats
   * a throw as non-fatal and proceeds with local cleanup, but that is
   * all-or-nothing at the call site — doing it here means a refresh token
   * still gets revoked when the access token is already dead, which is the
   * common case for a connection the user is disconnecting BECAUSE it stopped
   * working.
   */
  async revokeAccessToken({ token, refreshToken }) {
    const failures: string[] = []

    for (const [credential, label] of [
      [token,        'access']  as const,
      [refreshToken, 'refresh'] as const,
    ]) {
      if (!credential) continue
      try {
        await revokeHostexToken(credential)
      } catch (err) {
        failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (failures.length) {
      throw new Error(`Hostex token revocation failed — ${failures.join('; ')}`)
    }
  },

  async cleanupBeforeRevoke({ token, userId }) {
    // Deregister the inbound webhook while the token can still authorize it.
    // Revoking first would strand the registration permanently: Hostex would
    // keep pushing to a URL our route answers 401 to, forever, and the
    // operator's portal would still list a FieldStay webhook for an
    // integration they believe they removed.
    //
    // Dynamically imported because hostex-webhook.ts is `server-only` and this
    // adapter is reached through lib/integrations/registry.ts, which is pulled
    // into a much wider graph. A static import would drag the server-only
    // marker along with it and fail a build for a reason several hops from the
    // change that caused it.
    const { removeHostexWebhookRegistration } = await import('./hostex-webhook')
    await removeHostexWebhookRegistration(userId, token)
  },

  getApiHeaders(token: string): Record<string, string> {
    return {
      // NOT Authorization: Bearer — see HOSTEX_AUTH_HEADER above.
      [HOSTEX_AUTH_HEADER]: token,
      'Content-Type':       'application/json',
      'Accept':             'application/json',
      // Hostex's own Rate Limits doc explicitly recommends a meaningful
      // User-Agent — see the constant's comment above.
      'User-Agent':         HOSTEX_USER_AGENT,
    }
  },

  // NOT the live webhook path — see the note in this file's header. Hostex
  // deliveries land on app/api/webhooks/hostex/[token], which resolves the
  // connection from the URL token; nothing registers Hostex against the
  // generic /api/webhooks/[provider] route. These two exist only to satisfy
  // the IntegrationProvider interface, which does not mark them optional the
  // way it does the OAuth methods.
  //
  // Fails closed rather than throwing, so a request that somehow reaches the
  // generic route gets a clean rejection instead of a 500. Do NOT implement
  // them here as a second entry point: the token route is what carries the
  // trust-on-first-use secret claim, and a second unauthenticated path into
  // the same handler would bypass it.
  async validateWebhook(_request: Request): Promise<WebhookVerificationResult> {
    return fail('Hostex webhooks are handled at /api/webhooks/hostex/[token], not this route')
  },

  async handleWebhookEvent(): Promise<void> {
    console.warn(
      '[Hostex] handleWebhookEvent invoked on the generic provider route. ' +
      'Hostex deliveries belong at /api/webhooks/hostex/[token] — this is unreachable ' +
      'in normal operation and does nothing on purpose.'
    )
  },
}
