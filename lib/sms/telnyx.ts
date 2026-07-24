import { Redis } from '@upstash/redis'
import type { GuidebookOfferType } from '@/types/database'

const TELNYX_API_URL = 'https://api.telnyx.com/v2/messages'

// ── Daily nudge budget ───────────────────────────────────────────────────────
//
// Marketing-style sends (morning/evening nudges, gap-night offers) scale with
// guest count and have no natural ceiling — a platform-wide daily cap turns
// "runaway SMS spend" from a possibility into a bounded number. Transactional
// sends (door codes, work-order notifications, crew invites) are never
// blocked by the budget: a guest locked out of a property is worse than any
// overage.
//
// The cap is enforced with an atomic Redis INCR — the send only proceeds if
// this attempt's increment landed at or under the budget, so concurrent
// senders can't race past the ceiling. If Redis is unreachable, nudges FAIL
// CLOSED (skipped) — a cache outage must not disable the spend ceiling —
// while transactional sends are unaffected (they never consult Redis).

export type SmsCategory = 'transactional' | 'nudge'

const DEFAULT_DAILY_NUDGE_BUDGET = 500

// Same env names as lib/rate-limit.ts / lib/weather/tomorrow.ts — this
// project doesn't use the standard UPSTASH_REDIS_REST_* names.
let _redis: Redis | null = null
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url:   process.env.upstash_fieldstay_KV_REST_API_URL!,
      token: process.env.upstash_fieldstay_KV_REST_API_TOKEN!,
    })
  }
  return _redis
}

function dailyNudgeBudget(): number {
  const raw = Number(process.env.SMS_DAILY_NUDGE_BUDGET)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_NUDGE_BUDGET
}

/**
 * Atomically claims one slot of today's platform-wide nudge budget.
 * Returns true when this send may proceed.
 */
async function claimNudgeBudgetSlot(): Promise<boolean> {
  const day = new Date().toISOString().split('T')[0]
  const key = `sms:nudge:sent:${day}`
  const redis = getRedis()

  const count = await redis.incr(key)
  if (count === 1) {
    // 48h TTL — comfortably past the UTC day boundary, keeps keys from piling up
    await redis.expire(key, 48 * 60 * 60)
  }
  return count <= dailyNudgeBudget()
}

/**
 * Normalizes a NANP (North American Numbering Plan) phone number to E.164.
 * Returns null if the input cannot be parsed into a valid 10-digit NANP number.
 */
export function normalizePhoneToE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')

  if (digits.length === 10) {
    return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits) ? `+1${digits}` : null
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return /^1[2-9]\d{2}[2-9]\d{6}$/.test(digits) ? `+${digits}` : null
  }
  return null
}

export function formatOffer(
  offerType:       GuidebookOfferType,
  offerValue:      number | null,
  offerItem:       string | null,
  customOfferText: string | null
): string | null {
  switch (offerType) {
    case 'percentage':
      if (!offerValue) return null
      return offerItem
        ? `${offerValue}% off ${offerItem} — just show this screen`
        : `${offerValue}% off — just show this screen`

    case 'fixed_amount':
      if (!offerValue) return null
      return offerItem
        ? `$${offerValue % 1 === 0 ? offerValue : offerValue.toFixed(2)} off ${offerItem} — just show this screen`
        : `$${offerValue % 1 === 0 ? offerValue : offerValue.toFixed(2)} off — just show this screen`

    case 'item':
      return offerItem ? `Free ${offerItem} — just show this screen` : null

    case 'custom':
      return customOfferText ?? null

    case 'none':
    default:
      return null
  }
}

/**
 * Builds the sponsor line for morning/evening nudge SMS. A custom offer is
 * sent verbatim — the sponsor owns that copy entirely. Every other offer
 * type (including 'none') is wrapped in a default line that always names
 * the business, since a bare discount — or a silent nudge — is useless to
 * the guest without knowing who it's from.
 */
export function buildSponsorLine(
  businessName:    string,
  offerType:       GuidebookOfferType,
  offerValue:      number | null,
  offerItem:       string | null,
  customOfferText: string | null,
  distanceMiles:   number | null
): string {
  const locationSuffix = distanceMiles !== null ? ` (${distanceMiles.toFixed(1)} mi away)` : ''

  if (offerType === 'custom') {
    return customOfferText?.trim() || `Try ${businessName}${locationSuffix} — a local favorite.`
  }

  const offerLine = formatOffer(offerType, offerValue, offerItem, customOfferText)
  return offerLine
    ? `${businessName} has ${offerLine}${locationSuffix}.`
    : `Try ${businessName}${locationSuffix} — a local favorite.`
}

interface SendSmsResult {
  sent:   boolean
  reason?: string
}

/**
 * Sends an SMS via Telnyx. Gated behind SMS_ENABLED — until 10DLC registration
 * clears, this logs the would-be send instead of calling the Telnyx API.
 *
 * `category: 'nudge'` additionally subjects the send to the platform-wide
 * daily nudge budget (see claimNudgeBudgetSlot above). The default
 * 'transactional' never consults the budget.
 */
export async function sendSMS(
  toE164: string,
  body: string,
  opts?: { category?: SmsCategory }
): Promise<SendSmsResult> {
  if (process.env.SMS_ENABLED !== 'true') {
    // Never log the guest's phone number or message body — bodies can
    // contain door codes. Redacted to last 4 digits + length only, enough
    // to confirm a send would have happened without logging PII/credentials.
    console.log('[sms:disabled]', { to: `***${toE164.slice(-4)}`, bodyLength: body.length })
    return { sent: false, reason: 'SMS_ENABLED is not true' }
  }

  if ((opts?.category ?? 'transactional') === 'nudge') {
    let claimed = false
    try {
      claimed = await claimNudgeBudgetSlot()
    } catch (err) {
      // Fail closed: without Redis there is no spend ceiling, and a skipped
      // nudge is a non-event for the guest. Never applies to transactional.
      console.error('[sms:nudge-budget] Redis unavailable — skipping nudge send', {
        error: err instanceof Error ? err.message : String(err),
      })
      return { sent: false, reason: 'nudge budget check unavailable' }
    }
    if (!claimed) {
      console.warn('[sms:nudge-budget] daily nudge budget exhausted — skipping send')
      return { sent: false, reason: 'daily nudge budget exhausted' }
    }
  }

  const apiKey            = process.env.TELNYX_API_KEY
  const messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID
  const fromNumber         = process.env.TELNYX_FROM_NUMBER

  if (!apiKey || !messagingProfileId || !fromNumber) {
    throw new Error('Telnyx SMS env vars are not configured')
  }

  const response = await fetch(TELNYX_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:                 fromNumber,
      to:                   toE164,
      text:                 body,
      messaging_profile_id: messagingProfileId,
    }),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Telnyx send failed: ${response.status} ${errText}`)
  }

  return { sent: true }
}

export function buildDoorCodeSMS(
  propertyName: string,
  doorCode:     string,
  portalUrl:    string
): string {
  return [
    `${propertyName} — you're all set. 🏡`,
    ``,
    `Door code: ${doorCode}`,
    ``,
    `WiFi password + your local guide:`,
    portalUrl,
    ``,
    `Reply STOP to opt out.`,
  ].join('\n')
}

export function buildMorningNudgeSMS(
  propertyName: string,
  temperature:  number,
  offerLine:    string | null
): string {
  const base = `Good morning! It's ${Math.round(temperature)}°F at ${propertyName} today.`
  return offerLine ? `${base} ${offerLine} Reply STOP to opt out.` : `${base} Reply STOP to opt out.`
}

export function buildEveningNudgeSMS(
  propertyName: string,
  offerLine:    string | null
): string {
  const base = `Hope you're enjoying your stay at ${propertyName}!`
  return offerLine ? `${base} ${offerLine} Reply STOP to opt out.` : `${base} Reply STOP to opt out.`
}

export function buildRainAlertSMS(propertyName: string, sponsorLine: string | null): string {
  const base = `Heads up — rain expected near ${propertyName} today.`
  return sponsorLine
    ? `${base} ${sponsorLine} Reply STOP to opt out.`
    : `${base} Check your guidebook for rainy-day recommendations. Reply STOP to opt out.`
}

export function buildVendorWorkOrderSMS(params: {
  vendorName:   string
  woNumber:     string
  propertyName: string
  pmName:       string
  orgName:      string
  nteAmount:    number
  portalUrl:    string
  window?:      string   // pre-formatted: "11:00 AM – 3:00 PM CDT"
}): string {
  const nte = params.nteAmount > 0
    ? `\nNTE: $${params.nteAmount.toLocaleString()}`
    : ''
  const windowLine = params.window
    ? `\nAvailable window: ${params.window}\nProperty must be ready before guest check-in.`
    : ''

  return [
    `New work order from ${params.pmName} at ${params.orgName}:`,
    `${params.woNumber} — ${params.propertyName}${nte}${windowLine}`,
    ``,
    `Review & sign off:`,
    params.portalUrl,
    ``,
    `Reply STOP to opt out.`,
  ].join('\n')
}

export function buildCrewInviteSMS(params: {
  crewName:  string
  orgName:   string
  inviteUrl: string
}): string {
  return [
    `${params.orgName} invited you to their crew on FieldStay.`,
    ``,
    `Set up your account & install the crew app:`,
    params.inviteUrl,
    ``,
    `Reply STOP to opt out.`,
  ].join('\n')
}

export function buildCrewTurnoverAssignedSMS(params: {
  orgName:   string
  turnovers: Array<{
    propertyName:     string
    checkoutDatetime: string
    windowMinutes:    number
  }>
}): string {
  const lines = params.turnovers.map((t) => {
    const date    = new Date(t.checkoutDatetime)
    const dateStr = date.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
    })
    const windowHours = Math.round(t.windowMinutes / 60)
    const windowStr   = windowHours > 0 ? ` · ${windowHours}hr window` : ''
    return `• ${t.propertyName} — ${dateStr}${windowStr}`
  })

  return [
    `${params.orgName}: Turnover${params.turnovers.length > 1 ? 's' : ''} assigned 📋`,
    ...lines,
    ``,
    `Open your crew app for details & checklist.`,
    ``,
    `Reply STOP to opt out.`,
  ].join('\n')
}
