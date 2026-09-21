// lib/integrations/providers/lodgify.ts
// ============================================================================
// Lodgify API-key provider adapter.
//
// ⚠️ LIVE, AND UNVERIFIED AGAINST A REAL ACCOUNT. is_active = true
// (20260921170000_activate_lodgify_provider.sql), so a PM can connect this
// today — but no Lodgify account has ever been connected, and every response
// shape in lodgify.types.ts is still documentation-derived rather than seen.
//
// That is deliberate rather than an oversight, and it only holds because every
// guess in this integration fails LOUDLY: lodgifyExtractItems throws and
// reports the keys it actually saw rather than returning [], an unrecognised
// booking status reports to Sentry rather than defaulting silently, absent
// room counts stay null rather than overwriting a PM's correction, and money is
// gross or null. A wrong field name surfaces as a visible error on the
// connection, never as quietly wrong data on an owner statement.
//
// The first real connection is therefore the verification pass —
// docs/Integrations/lodgify/ENABLEMENT.md is the live checklist for it, and
// rolling back is one UPDATE with no deploy.
//
// LODGIFY SPECIFICS, and what each one costs us:
//
//   - PUBLIC, SELF-SERVE API. No partner program, no approval, no OAuth app.
//     The PM generates a key at Settings -> Public API in Lodgify and pastes
//     it into FieldStay. Their Lodgify plan must include API access
//     (Professional and above); a Starter customer has their reservations in
//     Lodgify and simply cannot produce a key, which is an onboarding fact
//     rather than an engineering one — it is why connectWithApiKey's failure
//     copy names the plan.
//   - AUTH IS `X-ApiKey`, a long-lived ACCOUNT-WIDE key. Not a Bearer token,
//     not scoped, and not expiring.
//   - THERE IS NO REVOCATION ENDPOINT. See revokeAccessToken below: this is
//     the weakest disconnect story of any provider here and is stated to the
//     PM rather than hidden.
//   - WEBHOOK AUTHENTICATION IS UNCONFIRMED, and it is the reason this
//     integration is shaped the way it is. Lodgify's subscribe call takes an
//     event and a target URL; no signing secret, shared secret or signature
//     header is documented anywhere reachable. So FieldStay treats a delivery
//     as an UNAUTHENTICATED PING that names nothing it is trusted about:
//     app/api/webhooks/lodgify/[token] authenticates on a 32-byte URL segment
//     it minted, reads at most an id out of the body, and every fact about the
//     booking is then re-read from the API with our own credential. If a
//     signature scheme turns out to exist, adding it STRENGTHENS this design
//     rather than changing it.
//
// Type definitions live in lodgify.types.ts; the authenticated data client
// lives in lodgify-api.ts (the adapter holds a credential, the client spends
// one — same split as hostex.ts/hostex-api.ts).
// ============================================================================

import type { IntegrationProvider } from '@/lib/integrations/types'
import { fail, type WebhookVerificationResult } from '@/lib/integrations/webhook-verification'
import { PMS_API_TIMEOUT_MS } from '@/lib/http/timeout'
import { reportError } from '@/lib/observability/report-error'
import type { LodgifyProperty } from '@/lib/integrations/providers/lodgify.types'

export * from './lodgify.types'

const LODGIFY_API_BASE = 'https://api.lodgify.com/v2'

/**
 * A meaningful User-Agent, the same courtesy Hostex's rate-limit docs ask for
 * explicitly. Lodgify publishes no such guidance, but a provider that has to
 * contact us about traffic from one deploy shared by every tenant should be
 * able to.
 */
const LODGIFY_USER_AGENT = 'FieldStay/1.0 (stephen@fieldstay.app)'

/** Lodgify's own header name for the account API key. */
export const LODGIFY_AUTH_HEADER = 'X-ApiKey'

export const lodgifyProvider: IntegrationProvider = {
  id:          'lodgify',
  displayName: 'Lodgify',
  authType:    'api_key',

  getApiHeaders(token: string): Record<string, string> {
    return {
      // NOT Authorization: Bearer — Lodgify authenticates on its own header.
      [LODGIFY_AUTH_HEADER]: token,
      'Content-Type':        'application/json',
      'Accept':              'application/json',
      'User-Agent':          LODGIFY_USER_AGENT,
    }
  },

  /**
   * NOT the live webhook path. Lodgify deliveries land on
   * app/api/webhooks/lodgify/[token], which resolves the connection from the
   * URL segment — there is nothing app-wide a delivery could be checked
   * against, because Lodgify documents no shared secret and no signature.
   *
   * Fails closed rather than throwing, so a request that somehow reaches the
   * generic /api/webhooks/[provider] route gets a clean rejection instead of a
   * 500. Do NOT implement it here as a second entry point: the token route is
   * what carries the only credential this provider has, and a second
   * unauthenticated path into the same handler would bypass it entirely.
   */
  async validateWebhook(_request: Request): Promise<WebhookVerificationResult> {
    return fail('Lodgify webhooks are handled at /api/webhooks/lodgify/[token], not this route')
  },

  async handleWebhookEvent(): Promise<void> {
    console.warn(
      '[Lodgify] handleWebhookEvent invoked on the generic provider route. ' +
      'Lodgify deliveries belong at /api/webhooks/lodgify/[token] — this is unreachable ' +
      'in normal operation and does nothing on purpose.'
    )
  },

  /**
   * Deregister our inbound webhooks while the key still works.
   *
   * Disconnect order matters even though there is no token to revoke: the key
   * is deleted from Vault immediately after this, and unsubscribing needs it.
   * Skip this and Lodgify keeps pushing to a URL our route answers 401 to
   * forever, while the PM's Lodgify portal still lists FieldStay webhooks for
   * an integration they believe they removed.
   *
   * Best-effort by contract — the caller logs a failure and proceeds with
   * local teardown regardless.
   *
   * Dynamically imported because lodgify-webhook.ts is `server-only` and this
   * adapter is reached through lib/integrations/registry.ts, which is pulled
   * into a much wider graph. A static import would drag the server-only marker
   * along with it and fail a build several hops from the change that caused it.
   */
  async cleanupBeforeRevoke({ token, userId }) {
    const { removeLodgifyWebhookRegistration } = await import('./lodgify-webhook')
    await removeLodgifyWebhookRegistration(userId, token)
  },

  /**
   * DELIBERATELY NOT IMPLEMENTED, and this is a real gap rather than an
   * omission.
   *
   * Lodgify exposes no endpoint that invalidates an API key, so disconnecting
   * removes FieldStay's copy from Vault and nothing else: the key itself stays
   * live in the PM's Lodgify account until they rotate it there. Every other
   * provider here can actually hang up (OwnerRez and Hostex revoke; Hostaway's
   * token at least expires).
   *
   * The interface marks this method optional, so leaving it off is the honest
   * encoding — a no-op implementation would report a successful revocation
   * that did not happen. The disconnect UI tells the PM to rotate the key in
   * Lodgify; see docs/Integrations/lodgify/ENABLEMENT.md.
   */
}

/**
 * Verify a PM-supplied API key and derive a proxy account identity.
 *
 * Called once at connect, before anything is written to Vault: a key that
 * cannot read a single property is not a connection, and storing it would
 * produce an integration that looks connected and syncs nothing.
 *
 * ── Why the identity is a property id ──────────────────────────────────────
 *
 * Lodgify has no "who am I" endpoint — no /me, /account or /user anywhere in
 * the documented surface — and TokenResponse requires an externalUserId. So
 * the first property's id stands in, exactly as Hostex does, with the same
 * known limits stated rather than papered over:
 *
 *   - An account with zero properties yields '' (empty). Logged, not fatal.
 *   - It is a PROPERTY id, not an account id, so it goes stale if that
 *     property is deleted. Nothing matches on it (Lodgify has no revocation
 *     webhook to attribute), so staleness has no functional consequence today.
 *     Do NOT build attribution against this value later without re-deriving
 *     it — it was never designed to be stable.
 *
 * Uses a raw fetch rather than lodgifyFetch: lodgify-api.ts imports this
 * module for its headers, and calling back into it would be a cycle. The cost
 * is that this one call sits outside the rate limiter, which is acceptable for
 * a single request made once per connect and never on a retry loop.
 *
 * @throws Error with a message safe to classify on (never the key, never the
 *         response body — connectWithApiKey maps it to PM-facing copy).
 */
export async function lodgifyVerifyApiKey(
  apiKey: string,
): Promise<{ externalUserId: string; propertyCount: number }> {
  const res = await fetch(`${LODGIFY_API_BASE}/properties?page=1&size=1&includeCount=true`, {
    signal:  AbortSignal.timeout(PMS_API_TIMEOUT_MS),
    headers: lodgifyProvider.getApiHeaders(apiKey),
  })

  if (res.status === 401 || res.status === 403) {
    // 403 is the interesting one and is NOT necessarily a bad key: Lodgify
    // gates the Public API on the account's plan, so a valid key on a Starter
    // subscription answers this way. The caller turns both into copy that
    // names the plan, because "invalid key" would send the PM to re-copy a key
    // that was never the problem.
    throw new Error(`Lodgify rejected the API key: HTTP ${res.status}`)
  }

  if (!res.ok) {
    throw new Error(`Lodgify key verification failed: HTTP ${res.status}`)
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(`Lodgify key verification returned a non-JSON body: HTTP ${res.status}`)
  }

  return {
    externalUserId: deriveExternalUserId(body),
    propertyCount:  countFrom(body),
  }
}

/** First property id, or '' — never throws; a connect must not fail on this. */
function deriveExternalUserId(body: unknown): string {
  try {
    const items = Array.isArray(body) ? body : (body as { items?: unknown })?.items
    const first = Array.isArray(items) ? items[0] as LodgifyProperty | undefined : undefined

    if (first?.id === undefined) {
      console.warn('[Lodgify] account has zero properties at connect time — externalUserId will be empty')
      return ''
    }

    return String(first.id)
  } catch (err) {
    console.warn('[Lodgify] externalUserId derivation threw — proceeding with empty externalUserId:', err)
    reportError(err, { site: 'lib.integrations.providers.lodgify.deriveExternalUserId' })
    return ''
  }
}

/**
 * The account's property count, when Lodgify reports one.
 *
 * Only ever used to tell the PM what we found ("connected — 12 properties"),
 * never to decide anything, so 0 on an unrecognised shape is harmless here in
 * a way it explicitly is NOT in lodgifyExtractItems.
 */
function countFrom(body: unknown): number {
  if (Array.isArray(body)) return body.length
  const count = (body as { count?: unknown })?.count
  return typeof count === 'number' && Number.isFinite(count) ? count : 0
}
