import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { normalizePhoneToE164 } from '@/lib/sms/telnyx'

// TODO: verify Telnyx webhook signature (ed25519) before processing —
// deferred for this session per CLAUDE_55_2 scope.
export async function POST(req: NextRequest) {
  const body = await req.json()

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
    await supabase
      .from('guidebook_guest_sms_optins')
      .update({ is_active: false, opted_out_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('phone_e164', phoneE164)
      .eq('is_active', true)
  } else if (text === 'START' || text === 'YES' || text === 'UNSTOP') {
    await supabase
      .from('guidebook_guest_sms_optins')
      .update({ is_active: true, opted_out_at: null, updated_at: new Date().toISOString() })
      .eq('phone_e164', phoneE164)
      .eq('is_active', false)
  }

  return NextResponse.json({ received: true })
}
