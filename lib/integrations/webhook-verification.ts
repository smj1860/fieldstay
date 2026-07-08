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

/**
 * Extracts the originating client IP from a request's `x-forwarded-for`
 * header — Vercel's edge network prepends the real client IP as the first
 * entry (not client-spoofable there), so the first comma-separated value is
 * the one to trust. Returns null if the header is absent or empty.
 */
export function extractClientIp(request: Request): string | null {
  const header = request.headers.get('x-forwarded-for')
  const first   = header?.split(',')[0]?.trim()
  return first?.length ? first : null
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

/**
 * Checks whether an IPv4 address falls within a CIDR range (e.g.
 * "38.80.170.0/24"). Used for providers (e.g. Hospitable) that advise IP
 * allowlisting as defense-in-depth alongside signature verification — the
 * signature check remains the primary control; this rejects out-of-range
 * traffic before it's even worth spending a crypto comparison on.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/')
  const bits    = parseInt(bitsStr ?? '', 10)
  const ipInt    = ipv4ToInt(ip)
  const rangeInt = range ? ipv4ToInt(range) : null

  if (ipInt === null || rangeInt === null || Number.isNaN(bits) || bits < 0 || bits > 32) {
    return false
  }

  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
  return (ipInt & mask) === (rangeInt & mask)
}
