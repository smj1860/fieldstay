import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient }       from '@/lib/supabase/server'
import { inngest }                   from '@/lib/inngest/client'
import { workOrderRatelimit }        from '@/lib/rate-limit'
import { extractClientIp }           from '@/lib/integrations/webhook-verification'

// Public, unauthenticated, token-gated route — rate limit by IP so a
// leaked/enumerated token can't drive unbounded repeated lookups or
// submissions. Fails open on a Redis outage.
async function checkRateLimit(request: NextRequest, key: string): Promise<NextResponse | null> {
  try {
    const ip = extractClientIp(request) ?? 'unknown'
    const { success } = await workOrderRatelimit.limit(`${key}:${ip}`)
    if (!success) {
      return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
    }
  } catch (rlErr) {
    console.error(`[work-orders/quote] rate limit check failed (${key})`, rlErr)
  }
  return null
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = await checkRateLimit(request, 'wo-quote-get')
  if (rateLimited) return rateLimited

  const { token }  = await params
  const supabase   = createServiceClient()

  const { data: qr } = await supabase
    .from('quote_requests')
    .select(`
      id, status, quote_token_expires_at,
      work_orders (
        id, title, description, scheduled_date, estimated_cost,
        properties (name, city, state)
      )
    `)
    .eq('quote_token', token)
    .single()

  if (!qr) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (new Date(qr.quote_token_expires_at) < new Date()) {
    return NextResponse.json({ error: 'This quote link has expired' }, { status: 410 })
  }

  const wo = Array.isArray(qr.work_orders) ? qr.work_orders[0] : qr.work_orders

  return NextResponse.json({
    quoteRequest: {
      id:                     qr.id,
      status:                 qr.status,
      quote_token_expires_at: qr.quote_token_expires_at,
    },
    workOrder: wo,
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = await checkRateLimit(request, 'wo-quote-post')
  if (rateLimited) return rateLimited

  const { token }  = await params
  const supabase   = createServiceClient()

  const { data: qr } = await supabase
    .from('quote_requests')
    .select('id, org_id, work_order_id, status, quote_token_expires_at')
    .eq('quote_token', token)
    .single()

  if (!qr) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })

  if (qr.status !== 'pending') {
    return NextResponse.json({ error: 'This quote request is no longer active' }, { status: 409 })
  }

  if (new Date(qr.quote_token_expires_at) < new Date()) {
    await supabase.from('quote_requests').update({ status: 'expired' }).eq('id', qr.id)
    return NextResponse.json({ error: 'This quote link has expired' }, { status: 410 })
  }

  const body          = await request.json().catch(() => ({})) as { amount?: number; notes?: string }
  const quoted_amount = parseFloat(String(body.amount ?? 0))
  const quote_notes   = (body.notes as string | undefined)?.trim() || null

  if (!Number.isFinite(quoted_amount) || quoted_amount <= 0) {
    return NextResponse.json({ error: 'A valid quote amount is required' }, { status: 400 })
  }

  const MAX_QUOTE_AMOUNT = 1_000_000 // $1M reasonable upper bound
  if (quoted_amount > MAX_QUOTE_AMOUNT) {
    return NextResponse.json(
      { error: 'Quote amount exceeds maximum allowed value.' },
      { status: 400 }
    )
  }

  const { data: updated } = await supabase
    .from('quote_requests')
    .update({
      status:       'submitted',
      quoted_amount,
      quote_notes,
      submitted_at: new Date().toISOString(),
    })
    .eq('id', qr.id)
    .eq('status', 'pending')
    .select('id')
    .single()

  if (!updated) {
    return NextResponse.json({ error: 'This quote has already been submitted' }, { status: 409 })
  }

  await supabase.from('work_order_updates').insert({
    work_order_id:             qr.work_order_id,
    org_id:                    qr.org_id,
    updated_via_vendor_portal: true,
    status_from:               null,
    status_to:                 null,
    notes: `Vendor submitted quote: $${quoted_amount.toFixed(2)}${quote_notes ? ' — ' + quote_notes : ''}`,
  })

  await inngest.send({
    name: 'work-order/quote-submitted' as const,
    data: {
      work_order_id:    qr.work_order_id,
      quote_request_id: qr.id,
      org_id:           qr.org_id,
      quoted_amount,
      quote_notes,
    },
  })

  return NextResponse.json({ success: true })
}
