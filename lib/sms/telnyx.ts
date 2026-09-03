import { getRedis, upstashConfigured } from '@/lib/redis'
import { reportError } from '@/lib/observability/report-error'
import type { GuidebookOfferType } from '@/types/database'
import { formatOffer } from '@/lib/guidebook/offer'
import { SMS_TIMEOUT_MS, isTimeoutError } from '@/lib/http/timeout'

export { formatOffer } from '@/lib/guidebook/offer'

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
//
// A claimed slot is RELEASED when the send definitively fails, so an Inngest
// retry of a flaky send doesn't burn one slot per attempt for messages that
// never reached a guest. The claim still happens before dispatch (that's
// what makes it atomic under concurrency); the release only ever gives a
// slot back, so it cannot let more messages out than the budget allows.

export type SmsCategory = 'transactional' | 'nudge'

const DEFAULT_DAILY_NUDGE_BUDGET = 500

// Client comes from lib/redis.ts — one construction site for the whole app.

function dailyNudgeBudget(): number {
  const raw = Number(process.env.SMS_DAILY_NUDGE_BUDGET)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_NUDGE_BUDGET
}

function nudgeBudgetKey(): string {
  const day = new Date().toISOString().split('T')[0]
  return `sms:nudge:sent:${day}`
}

/**
 * Atomically claims one slot of today's platform-wide nudge budget.
 * Returns true when this send may proceed.
 *
 * Throws on a Redis error — sendSMS turns that into a skipped nudge
 * (fail CLOSED), because a cache outage must never remove the spend ceiling.
 */
async function claimNudgeBudgetSlot(): Promise<boolean> {
  // No Upstash in this environment means there is no shared ceiling to claim
  // against. Refusing the slot keeps the guarantee the caller depends on — the
  // budget must not silently become unlimited — and matches where the
  // fail-CLOSED catch in the caller already lands on a Redis outage. Skipping
  // the call also avoids one doomed fetch per nudge.
  if (!upstashConfigured()) return false

  const key   = nudgeBudgetKey()
  const redis = getRedis()

  const count = await redis.incr(key)
  if (count === 1) {
    // 48h TTL — comfortably past the UTC day boundary, keeps keys from piling up
    await redis.expire(key, 48 * 60 * 60)
  }
  return count <= dailyNudgeBudget()
}

/**
 * Returns a claimed slot to today's budget after a send definitively failed.
 *
 * The claim has to happen BEFORE the Telnyx call — it is the atomic INCR
 * that makes concurrent senders unable to race past the ceiling, and a
 * claim-after-dispatch would lose that. But sendSMS throws on a non-2xx,
 * and Inngest re-enters it on retry, so without a release one flaky send
 * consumed up to `retries + 1` slots of a budget that exists to bound spend
 * on messages that were never actually delivered.
 *
 * A failed release is deliberately swallowed after logging: the failure
 * mode is "the budget stays slightly over-consumed", which errs toward
 * sending fewer nudges — the same direction the fail-closed claim errs in.
 * Never increases the number of messages that can go out.
 */
async function releaseNudgeBudgetSlot(): Promise<void> {
  // Nothing was claimed when Upstash is unconfigured (claimNudgeBudgetSlot
  // returns false without incrementing), so there is nothing to give back.
  if (!upstashConfigured()) return

  try {
    await getRedis().decr(nudgeBudgetKey())
  } catch (err) {
    console.warn('[sms:nudge-budget] failed to release slot after a failed send', {
      error: err instanceof Error ? err.message : String(err),
    })
    reportError(err, { site: 'sms.telnyx.nudge_budget_release_failed' })
  }
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
 * Returns a delivered-looking result (and writes demo_activity_log) when the
 * org is the roadshow demo tenant; null when it is a real org and the send
 * should proceed normally.
 *
 * The demo modules are imported lazily so this file — which is imported by
 * template helpers across the app — does not pull the Supabase service client
 * and its next/headers dependency into every module graph that touches SMS
 * copy. On the overwhelmingly common path (no orgId, or a real org) nothing
 * here is loaded at all.
 */
async function suppressIfDemoOrg(
  orgId:    string,
  toE164:   string,
  body:     string,
  category: SmsCategory | undefined,
): Promise<SendSmsResult | null> {
  try {
    const [{ isDemoOrg }, { simulateOrSend, redactPhone }] = await Promise.all([
      import('@/lib/demo/org'),
      import('@/lib/demo/simulate'),
    ])

    if (!(await isDemoOrg(orgId))) return null

    return await simulateOrSend<SendSmsResult>(
      true,
      {
        orgId,
        kind:    'sms',
        // Redacted for the same reason the [sms:disabled] log below is:
        // bodies carry door codes, and this row is readable by every member
        // of the org. Length is enough to prove the send was composed.
        payload: {
          to:         redactPhone(toE164),
          bodyLength: body.length,
          category:   category ?? 'transactional',
        },
      },
      // Unreachable — simulateOrSend only calls realSend when isDemo is false.
      async () => ({ sent: false, reason: 'unreachable' }),
      { sent: true },
    )
  } catch (err) {
    // A failure to resolve demo status must not silently become a real send
    // to a fake 555 number during the demo. Fail CLOSED: suppress the send
    // and say why.
    console.error('[sms:demo-check] failed — suppressing send', {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    })
    reportError(err, { site: 'lib.sms.telnyx.suppressIfDemoOrg' })
    return { sent: false, reason: 'demo status check failed' }
  }
}

/**
 * Sends an SMS via Telnyx. Gated behind SMS_ENABLED — until 10DLC registration
 * clears, this logs the would-be send instead of calling the Telnyx API.
 *
 * `category: 'nudge'` additionally subjects the send to the platform-wide
 * daily nudge budget (see claimNudgeBudgetSlot above). The default
 * 'transactional' never consults the budget.
 *
 * `orgId` opts the send into demo-org suppression: when that org has
 * is_demo = true, the message is recorded in demo_activity_log and answered
 * with a delivered-looking result instead of dispatched. This check lives
 * HERE, at the same chokepoint as SMS_ENABLED, precisely so it cannot be
 * forgotten at an individual call site — the same reasoning that put the
 * SMS_ENABLED gate in this function rather than in its 12 callers.
 */
export async function sendSMS(
  toE164: string,
  body: string,
  opts?: { category?: SmsCategory; orgId?: string }
): Promise<SendSmsResult> {
  // Demo suppression is checked BEFORE the SMS_ENABLED early-return: the
  // demo's whole point is showing a completed send, so the activity row must
  // be written even while SMS is globally disabled — and if SMS_ENABLED is
  // flipped to true before the event, the demo org must still never dispatch.
  if (opts?.orgId) {
    const demoResult = await suppressIfDemoOrg(opts.orgId, toE164, body, opts.category)
    if (demoResult) return demoResult
  }

  if (process.env.SMS_ENABLED !== 'true') {
    // Never log the guest's phone number or message body — bodies can
    // contain door codes. Redacted to last 4 digits + length only, enough
    // to confirm a send would have happened without logging PII/credentials.
    console.log('[sms:disabled]', { to: `***${toE164.slice(-4)}`, bodyLength: body.length })
    return { sent: false, reason: 'SMS_ENABLED is not true' }
  }

  // Env validation runs BEFORE the budget claim: a misconfigured deploy
  // must not consume budget slots on sends that can never dispatch.
  const apiKey            = process.env.TELNYX_API_KEY
  const messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID
  const fromNumber         = process.env.TELNYX_FROM_NUMBER

  if (!apiKey || !messagingProfileId || !fromNumber) {
    throw new Error('Telnyx SMS env vars are not configured')
  }

  const isNudge = (opts?.category ?? 'transactional') === 'nudge'

  if (isNudge) {
    const budget = await claimNudgeSlotOrExplain()
    if (budget) return budget
  }

  // Everything from here on can throw, and every throw reaches an Inngest
  // retry that re-enters sendSMS and claims a fresh slot — so a claimed
  // slot must be released on the way out.
  try {
    await dispatchToTelnyx({ apiKey, messagingProfileId, fromNumber, toE164, body })
    return { sent: true }
  } catch (err) {
    if (isNudge) await releaseNudgeBudgetSlot()
    throw err
  }
}

/**
 * Claims a nudge budget slot. Returns null when the send may proceed, or the
 * SendSmsResult to return to the caller when it may not.
 */
async function claimNudgeSlotOrExplain(): Promise<SendSmsResult | null> {
  let claimed = false
  try {
    claimed = await claimNudgeBudgetSlot()
  } catch (err) {
    // Fail closed: without Redis there is no spend ceiling, and a skipped
    // nudge is a non-event for the guest. Never applies to transactional.
    console.error('[sms:nudge-budget] Redis unavailable — skipping nudge send', {
      error: err instanceof Error ? err.message : String(err),
    })
    reportError(err, { site: 'sms.telnyx.nudge_budget_unavailable' })
    return { sent: false, reason: 'nudge budget check unavailable' }
  }

  if (!claimed) {
    console.warn('[sms:nudge-budget] daily nudge budget exhausted — skipping send')
    return { sent: false, reason: 'daily nudge budget exhausted' }
  }

  return null
}

/** Issues the Telnyx call. Throws on timeout or any non-2xx response. */
async function dispatchToTelnyx(params: {
  apiKey:              string
  messagingProfileId:  string
  fromNumber:          string
  toE164:              string
  body:                string
}): Promise<void> {
  let response: Response
  try {
    response = await fetch(TELNYX_API_URL, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:                 params.fromNumber,
        to:                   params.toE164,
        text:                 params.body,
        messaging_profile_id: params.messagingProfileId,
      }),
      signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
    })
  } catch (err) {
    // A timeout is genuinely ambiguous — Telnyx may or may not have accepted
    // the message — so it surfaces as its own distinct failure rather than a
    // generic send error, and is rethrown so Inngest retries it.
    if (isTimeoutError(err)) {
      throw new Error(`Telnyx send timed out after ${SMS_TIMEOUT_MS}ms`)
    }
    throw err
  }

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Telnyx send failed: ${response.status} ${errText}`)
  }
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

export function buildTomorrowOutdoorSMS(propertyName: string, offerLine: string | null): string {
  // Sent the EVENING BEFORE, about tomorrow — the tense is the whole point of
  // the message and the reason this is not a variant of the evening nudge.
  const base = `Tomorrow looks clear near ${propertyName} — a good day to get outside.`
  return offerLine
    ? `${base} ${offerLine} Reply STOP to opt out.`
    : `${base} Check your guidebook for local ideas. Reply STOP to opt out.`
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
