// lib/integrations/webhook-verification.ts
// ============================================================
// Shared contract and helpers for verifying inbound webhooks.
//
// Every provider's validateWebhook() (lib/integrations/providers/*.ts) and
// the two providers with dedicated routes outside the generic
// app/api/webhooks/[provider]/route.ts handler (Stripe, Telnyx) return or
// use pieces of this same shape, so a rejected webhook always carries a
// reason for logging instead of a bare boolean.
//
// Not every provider's auth scheme includes a timestamp:
//   - OwnerRez:    HTTP Basic Auth — no timestamp concept at all
//   - Hospitable:  HMAC-SHA256 over the raw body only — no timestamp mixed in
//   - Telnyx:      Ed25519 over `timestamp|body` — DOES include one, see below
//   - Stripe:      SDK's constructEvent() already enforces its own tolerance
//                   window internally — isTimestampFresh is not used there
// For schemes with no timestamp, replay protection comes entirely from the
// processed_webhooks dedup table (app/api/webhooks/[provider]/route.ts),
// keyed by the provider's own event id — there is nothing else to check.
// ============================================================

export interface WebhookVerificationResult {
  valid: boolean
  /** Present when valid === false. Never contains the secret/signature itself. */
  reason?: string
}

export function ok(): WebhookVerificationResult {
  return { valid: true }
}

export function fail(reason: string): WebhookVerificationResult {
  return { valid: false, reason }
}

/**
 * Constant-time string comparison to prevent timing-based credential attacks.
 * Regular === comparison leaks information about where strings differ.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

/**
 * Reject a webhook whose signed timestamp is more than `toleranceSeconds`
 * away from now (in either direction). Closes the indefinite-replay window
 * a bare signature check leaves open — a captured, cryptographically valid
 * webhook stays forever-replayable unless something checks freshness too.
 * Default tolerance (300s) matches Stripe SDK's own default.
 */
export function isTimestampFresh(timestampSeconds: number, toleranceSeconds = 300): boolean {
  const skew = Math.abs(Date.now() / 1000 - timestampSeconds)
  return skew <= toleranceSeconds
}
