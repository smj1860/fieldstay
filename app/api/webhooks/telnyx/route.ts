import { NextRequest, NextResponse } from 'next/server'
import { createVerify } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { normalizePhoneToE164 } from '@/lib/sms/telnyx'
import { logAuditEvent } from '@/lib/audit'

// ── Signature verification ────────────────────────────────────────────────────
// Telnyx signs webhooks with ed25519. The signed payload is `timestamp|rawBody`.
// Public key comes from Telnyx Portal → API Keys → Ed25519 Public Key.
function verifyTelnyxSignature(
  rawBody:   string,
  signature: string | null,
  timestamp: string | null
): boolean {
  const publicKey = process.env.TELNYX_WEBHOOK_PUBLIC_KEY
  if (!publicKey || !signature || !timestamp) return false

  try {
    const signedPayload = `${timestamp}|${rawBody}`
    const verifier      = createVerify('ed25519')
    verifier.update(signedPayload)
    return verifier.verify(
      Buffer.from(publicKey, 'base64'),
      Buffer.from(signature, 'base64')
    )
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  // Read raw body FIRST — signature is computed over the exact bytes
  const rawBody   = await req.text()
  const signature = req.headers.get('telnyx-signature-ed25519')
  const timestamp = req.headers.get('telnyx-timestamp')

  // ── Verify signature before processing any payload ──────────────────────────
  if (!verifyTelnyxSignature(rawBody, signature, timestamp)) {
    console.error('[Telnyx webhook] Signature verification failed')
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

  const supabase = createServiceClient()

  if (text === 'STOP' || text === 'STOPALL' || text === 'UNSUBSCRIBE' || text === 'CANCEL' || text === 'END' || text === 'QUIT') {
    const { data: updated } = await supabase
      .from('guidebook_guest_sms_optins')
      .update({ is_active: false, opted_out_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('phone_e164', phoneE164)
      .eq('is_active', true)
      .select('org_id')

    for (const row of updated ?? []) {
      await logAuditEvent({
        orgId:      row.org_id,
        action:     'sms.consent.revoked',
        targetType: 'guidebook_guest_sms_optin',
        metadata:   { reason: text },
      }).catch(err =>
        console.error('[Telnyx] audit log failed:', err)
      )
    }
  } else if (text === 'START' || text === 'YES' || text === 'UNSTOP') {
    const { data: updated } = await supabase
      .from('guidebook_guest_sms_optins')
      .update({ is_active: true, opted_out_at: null, updated_at: new Date().toISOString() })
      .eq('phone_e164', phoneE164)
      .eq('is_active', false)
      .select('org_id')

    for (const row of updated ?? []) {
      await logAuditEvent({
        orgId:      row.org_id,
        action:     'sms.consent.restored',
        targetType: 'guidebook_guest_sms_optin',
        metadata:   { reason: text },
      }).catch(err =>
        console.error('[Telnyx] audit log failed:', err)
      )
    }
  }

  return NextResponse.json({ received: true })
}
