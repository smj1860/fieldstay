import { NextRequest, NextResponse } from 'next/server'
import { verify as verifyEd25519, createPublicKey, createHash } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { normalizePhoneToE164 } from '@/lib/sms/telnyx'
import { logAuditEvents } from '@/lib/audit'
import { isTimestampFresh } from '@/lib/integrations/webhook-verification'
import { reportError } from '@/lib/observability/report-error'

// ── Signature verification ────────────────────────────────────────────────────
// Telnyx signs webhooks with ed25519. The signed payload is `timestamp|rawBody`.
// Public key comes from Telnyx Portal → API Keys → Ed25519 Public Key — a
// base64 encoding of the raw 32-byte public key.
//
// Node's crypto has no streaming update() support for EdDSA (createVerify/
// createSign only support digest-based algorithms) — confirmed live: calling
// createVerify('ed25519').update(...) throws "Invalid digest" every time,
// which the surrounding try/catch silently turned into "signature invalid",
// meaning every real Telnyx webhook was being rejected regardless of whether
// its signature was actually valid. Ed25519 requires the one-shot verify()
// function instead, with the raw public key reconstructed as a JWK (OKP/
// Ed25519) key object since createPublicKey has no bare "raw bytes" import
// format for asymmetric keys.
//
// A cryptographically valid signature alone doesn't expire — without also
// checking the signed timestamp, a captured request stays replayable
// forever. isTimestampFresh() closes that window (5 min tolerance, same
// default Stripe's SDK uses for its own webhook verification).
export function verifyTelnyxSignature(
  rawBody:   string,
  signature: string | null,
  timestamp: string | null
): boolean {
  const publicKeyB64 = process.env.TELNYX_WEBHOOK_PUBLIC_KEY
  if (!publicKeyB64 || !signature || !timestamp) return false

  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds) || !isTimestampFresh(timestampSeconds)) return false

  try {
    const signedPayload = `${timestamp}|${rawBody}`
    const publicKey = createPublicKey({
      key:    { kty: 'OKP', crv: 'Ed25519', x: base64ToBase64Url(publicKeyB64) },
      format: 'jwk',
    })
    return verifyEd25519(null, Buffer.from(signedPayload), publicKey, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

function base64ToBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Claims this exact signed delivery, returning false if it was already
 * processed.
 *
 * ⚠️ REPLAY-PROTECTION CONTRACT FOR THIS HANDLER (audit 2026-07-30, L-3)
 *
 * Ed25519 verification proves authenticity, not freshness — a captured
 * request stays cryptographically valid forever. Until now the ONLY thing
 * bounding replay here was verifyTelnyxSignature's 300-second freshness
 * window, which means an attacker who captured a request could replay it
 * freely for five minutes. That was harmless purely because every branch
 * below is idempotent: the STOP/START handlers are conditional UPDATEs
 * (`.eq('is_active', true)` / `.eq('is_active', false)`) that match zero rows
 * on a second run, so a replay writes nothing and logs no audit event.
 *
 * That is a property of the current branches, not of the route. A future
 * branch that inserts a row, sends a message, or charges anything would
 * silently become replayable inside that 5-minute window with nothing
 * failing. The claim below removes the dependency on that reasoning: a
 * replay is byte-identical over the SIGNED payload (`timestamp|rawBody`), so
 * it hashes identically and is rejected here regardless of what the branches
 * do.
 */
function telnyxWebhookId(signedPayload: string): string {
  return `telnyx:${createHash('sha256').update(signedPayload).digest('hex')}`
}

async function claimTelnyxDelivery(
  supabase: ReturnType<typeof createServiceClient>,
  webhookId: string,
): Promise<boolean> {
  const { error } = await supabase.from('processed_webhooks').insert({ webhook_id: webhookId })

  if (!error) return true
  if (error.code === '23505') return false

  // Non-fatal: a dedup-table outage must not drop real inbound STOP messages,
  // which carry a TCPA compliance obligation. Log loudly and continue — the
  // branches below are individually idempotent (see contract above).
  console.error(`[Telnyx webhook] dedup insert failed (non-fatal): ${error.code} ${error.message}`)
  reportError(new Error(error.message), { site: 'webhook.telnyx.dedup_insert' })
  return true
}

export async function POST(req: NextRequest) {
  // Read raw body FIRST — signature is computed over the exact bytes
  const rawBody   = await req.text()
  const signature = req.headers.get('telnyx-signature-ed25519')
  const timestamp = req.headers.get('telnyx-timestamp')

  // ── Verify signature before processing any payload ──────────────────────────
  if (!verifyTelnyxSignature(rawBody, signature, timestamp)) {
    console.error('[Telnyx webhook] Signature verification failed (invalid signature or stale timestamp)')
    reportError(new Error('Telnyx webhook signature verification failed'), { site: 'webhook.telnyx.signature_verification' })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // ── Parse payload (after verification) ──────────────────────────────────────
  let body: {
    data?: {
      event_type?: string
      payload?: {
        from?: { phone_number?: string }
        text?: string
      }
    }
  }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const eventType = body?.data?.event_type as string | undefined
  if (eventType !== 'message.received') {
    return NextResponse.json({ received: true })
  }

  const fromNumber = body?.data?.payload?.from?.phone_number as string | undefined
  const text        = (body?.data?.payload?.text as string | undefined)?.trim().toUpperCase()

  if (!fromNumber || !text) {
    return NextResponse.json({ received: true })
  }

  const phoneE164 = normalizePhoneToE164(fromNumber)
  if (!phoneE164) {
    return NextResponse.json({ received: true })
  }

  const supabase = createServiceClient({ publicSurface: 'api-webhooks-telnyx' })

  // Replay guard — see claimTelnyxDelivery's contract note above.
  const webhookId = telnyxWebhookId(`${timestamp}|${rawBody}`)
  if (!(await claimTelnyxDelivery(supabase, webhookId))) {
    return NextResponse.json({ received: true, duplicate: true })
  }

  try {
    await applyConsentChange(supabase, phoneE164, text)
  } catch (err) {
    // The claim above was written BEFORE this ran, so leaving it in place
    // would make Telnyx's retry hash-collide and be discarded as a duplicate
    // — permanently losing a STOP, which is a TCPA compliance obligation.
    // Release it and 500 so Telnyx retries. Same pattern as the Stripe,
    // Stripe Connect and generic-provider webhook routes.
    console.error('[Telnyx webhook] consent update failed:', err)
    reportError(err, { site: 'webhook.telnyx.handler' })

    const { error: releaseErr } = await supabase
      .from('processed_webhooks')
      .delete()
      .eq('webhook_id', webhookId)

    if (releaseErr) {
      console.error('[Telnyx webhook] failed to release dedup claim:', releaseErr.message)
      reportError(new Error(releaseErr.message), { site: 'webhook.telnyx.dedup_release' })
    }

    return NextResponse.json({ error: 'Handler failed' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}

const STOP_KEYWORDS  = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'])
const START_KEYWORDS = new Set(['START', 'YES', 'UNSTOP'])

async function applyConsentChange(
  supabase:  ReturnType<typeof createServiceClient>,
  phoneE164: string,
  text:      string,
): Promise<void> {
  if (STOP_KEYWORDS.has(text)) {
    const { data: updated, error } = await supabase
      .from('guidebook_guest_sms_optins')
      .update({ is_active: false, opted_out_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('phone_e164', phoneE164)
      .eq('is_active', true)
      .select('org_id')

    // Throwing (rather than swallowing) is what routes this into the
    // caller's release-the-claim + 500 path. A dropped STOP is a TCPA
    // violation — it must become a Telnyx retry, never a silent 200.
    if (error) throw new Error(`STOP consent revoke failed: ${error.message}`)

    // logAuditEvents batches the whole set into one insert and never
    // rejects (swallows and logs internally) — no per-row catch needed.
    await logAuditEvents(
      (updated ?? []).map((row) => ({
        orgId:      row.org_id,
        action:     'sms.consent.revoked' as const,
        targetType: 'guidebook_guest_sms_optin',
        metadata:   { reason: text },
      }))
    )
  } else if (START_KEYWORDS.has(text)) {
    const { data: updated, error } = await supabase
      .from('guidebook_guest_sms_optins')
      .update({ is_active: true, opted_out_at: null, updated_at: new Date().toISOString() })
      .eq('phone_e164', phoneE164)
      .eq('is_active', false)
      .select('org_id')

    if (error) throw new Error(`START consent restore failed: ${error.message}`)

    // logAuditEvents batches the whole set into one insert and never
    // rejects (swallows and logs internally) — no per-row catch needed.
    await logAuditEvents(
      (updated ?? []).map((row) => ({
        orgId:      row.org_id,
        action:     'sms.consent.restored' as const,
        targetType: 'guidebook_guest_sms_optin',
        metadata:   { reason: text },
      }))
    )
  }
}
