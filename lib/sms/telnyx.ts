import type { GuidebookOfferType } from '@/types/database'

const TELNYX_API_URL = 'https://api.telnyx.com/v2/messages'

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

interface SendSmsResult {
  sent:   boolean
  reason?: string
}

/**
 * Sends an SMS via Telnyx. Gated behind SMS_ENABLED — until 10DLC registration
 * clears, this logs the would-be send instead of calling the Telnyx API.
 */
export async function sendSMS(toE164: string, body: string): Promise<SendSmsResult> {
  if (process.env.SMS_ENABLED !== 'true') {
    // Never log the guest's phone number or message body — bodies can
    // contain door codes. Redacted to last 4 digits + length only, enough
    // to confirm a send would have happened without logging PII/credentials.
    console.log('[sms:disabled]', { to: `***${toE164.slice(-4)}`, bodyLength: body.length })
    return { sent: false, reason: 'SMS_ENABLED is not true' }
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

export function buildRainAlertSMS(propertyName: string): string {
  return `Heads up — rain expected near ${propertyName} today. Check your guidebook for rainy-day recommendations. Reply STOP to opt out.`
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
