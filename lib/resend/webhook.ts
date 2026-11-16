// ============================================================================
// Resend webhook: signature verification and event classification.
//
// Resend signs webhooks with Svix. Three headers carry the proof:
//   svix-id         unique per delivery (a retry reuses it)
//   svix-timestamp  unix seconds
//   svix-signature  one or more space-separated `v1,<base64 hmac>` entries
// The signed content is `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256
// with the secret. The secret the dashboard shows is `whsec_<base64>`; the key is
// the base64-DECODED part after the prefix.
//
// Implemented with node:crypto rather than the svix package so the repo gains no
// dependency for forty lines of HMAC. Pure and dependency-free on purpose: the
// route and the unit tests both import it.
// ============================================================================

import { createHmac, timingSafeEqual } from 'node:crypto'

import { isTimestampFresh } from '@/lib/integrations/webhook-verification'

export interface SvixHeaders {
  id:        string | null
  timestamp: string | null
  signature: string | null
}

function decodeSecret(secret: string): Buffer | null {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  if (!raw) return null
  const key = Buffer.from(raw, 'base64')
  return key.length > 0 ? key : null
}

function safeEqualBase64(a: string, b: string): boolean {
  const left  = Buffer.from(a, 'base64')
  const right = Buffer.from(b, 'base64')
  // timingSafeEqual throws on unequal lengths; unequal lengths are simply "no match".
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

/**
 * True only for a correctly signed, recent delivery. Fails CLOSED: a missing
 * secret, header, or a stale timestamp is a rejection, never a pass.
 */
export function verifyResendSignature(
  rawBody: string,
  headers: SvixHeaders,
  secret:  string | undefined,
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false

  const timestampSeconds = Number(headers.timestamp)
  if (!Number.isFinite(timestampSeconds) || !isTimestampFresh(timestampSeconds)) return false

  const key = decodeSecret(secret)
  if (!key) return false

  const expected = createHmac('sha256', key)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`)
    .digest('base64')

  // The header may carry several signatures (secret rotation): any v1 match passes.
  return headers.signature
    .split(' ')
    .map((part) => part.split(','))
    .some(([version, sig]) => version === 'v1' && sig !== undefined && safeEqualBase64(expected, sig))
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface ResendEvent {
  type: string
  data: {
    email_id?: string
    to?:       string[]
    bounce?:   { type?: string; subType?: string }
  }
}

/** What an event means for the person who sent the mail. */
export type EmailProblem = 'bounced' | 'complained' | 'suppressed' | 'failed'

export function parseResendEvent(rawBody: string): ResendEvent | null {
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (typeof parsed !== 'object' || parsed === null) return null
    const event = parsed as { type?: unknown; data?: unknown }
    if (typeof event.type !== 'string') return null
    const data = typeof event.data === 'object' && event.data !== null ? event.data : {}
    return { type: event.type, data: data as ResendEvent['data'] }
  } catch {
    return null
  }
}

/**
 * Which events are a problem worth telling someone about.
 *
 * A TRANSIENT bounce (mailbox full, server briefly down) is Resend's own retry
 * to make and usually clears, so it is not reported. Permanent and undetermined
 * bounces will not fix themselves: the address is wrong or gone.
 */
export function classifyEvent(event: ResendEvent): EmailProblem | null {
  switch (event.type) {
    case 'email.bounced': {
      const kind = event.data.bounce?.type?.toLowerCase()
      return kind === 'transient' ? null : 'bounced'
    }
    case 'email.complained': return 'complained'
    case 'email.suppressed': return 'suppressed'
    case 'email.failed':     return 'failed'
    default:                 return null
  }
}

/** Plain-language title for the in-app bell. No em dashes: this is customer-facing copy. */
export function problemTitle(problem: EmailProblem, recipientName: string): string {
  switch (problem) {
    case 'bounced':    return `Email to ${recipientName} could not be delivered`
    case 'complained': return `${recipientName} marked a FieldStay email as spam`
    case 'suppressed': return `Email to ${recipientName} was not sent`
    case 'failed':     return `Email to ${recipientName} failed to send`
  }
}

/** One line on what to do about it. */
export function problemHint(problem: EmailProblem): string {
  switch (problem) {
    case 'bounced':    return 'The address may be misspelled or no longer exists. Check it and update the contact.'
    case 'complained': return 'We will stop emailing this address. Reach them another way.'
    case 'suppressed': return 'This address bounced before, so email to it is blocked. Check the address.'
    case 'failed':     return 'The email did not go out. Try again, or contact them another way.'
  }
}

/** Addresses to look up: as sent, plus lowercased, de-duplicated. Stored contacts are not always lowercased. */
export function lookupAddresses(recipients: readonly string[] | undefined): string[] {
  const out = new Set<string>()
  for (const raw of recipients ?? []) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    out.add(trimmed)
    out.add(trimmed.toLowerCase())
  }
  return [...out].slice(0, 20)
}
