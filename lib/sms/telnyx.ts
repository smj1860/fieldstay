import type { GuidebookOfferType } from '@/types/database'

const TELNYX_API_URL = 'https://api.telnyx.com/v2/messages'

/**
 * Normalizes a NANP (North American Numbering Plan) phone number to E.164.
 * Returns null if the input cannot be parsed into a valid 10-digit NANP number.
 */
export function normalizePhoneToE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')

  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`

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
      return offerValue ? `${offerValue}% off for guests` : null
    case 'fixed_amount':
      return offerValue ? `$${offerValue.toFixed(2)} off for guests` : null
    case 'item':
      return offerItem ? `Free ${offerItem} for guests` : null
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
    console.log('[sms:disabled]', { to: toE164, body })
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

export function buildDoorCodeSMS(propertyName: string, doorCode: string): string {
  return `Welcome to ${propertyName}! Your door code is: ${doorCode}. Reply STOP to opt out of texts.`
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
