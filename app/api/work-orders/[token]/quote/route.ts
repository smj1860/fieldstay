import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'

/**
 * GET /api/work-orders/[token]/quote
 * Returns WO details so the quote portal page can render.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const supabase  = createServiceClient()

  const { data: wo } = await supabase
    .from('work_orders')
    .select(`
      id, title, description, status, scheduled_date,
      estimated_cost, quote_token_expires_at,
      properties (name, city, state)
    `)
    .eq('quote_token', token)
    .single()

  if (!wo) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({ workOrder: wo })
}

/**
 * POST /api/work-orders/[token]/quote
 * Body: { amount: number, notes?: string }
 * Vendor submits their quote; WO status remains quote_requested, PM is notified.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const supabase  = createServiceClient()

  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, org_id, status, quote_token_expires_at')
    .eq('quote_token', token)
    .single()

  if (!wo) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })

  if (wo.status !== 'quote_requested') {
    return NextResponse.json({ error: 'Quote no longer needed for this work order' }, { status: 409 })
  }

  if (wo.quote_token_expires_at && new Date(wo.quote_token_expires_at) < new Date()) {
    return NextResponse.json({ error: 'This quote link has expired' }, { status: 410 })
  }

  const body = await request.json().catch(() => ({})) as { amount?: number; notes?: string }
  const quoted_amount = parseFloat(String(body.amount ?? 0))
  const quote_notes   = (body.notes as string | undefined)?.trim() || null

  if (!quoted_amount || quoted_amount <= 0) {
    return NextResponse.json({ error: 'A valid quote amount is required' }, { status: 400 })
  }

  await supabase
    .from('work_orders')
    .update({ quoted_amount, quote_notes })
    .eq('id', wo.id)

  await supabase.from('work_order_updates').insert({
    work_order_id:             wo.id,
    org_id:                    wo.org_id,
    updated_via_vendor_portal: true,
    status_from:               'quote_requested',
    status_to:                 'quote_requested',
    notes:                     `Vendor submitted quote: $${quoted_amount.toFixed(2)}${quote_notes ? ` — ${quote_notes}` : ''}`,
  })

  await inngest.send({
    name: 'work-order/quote-submitted' as const,
    data: {
      work_order_id: wo.id,
      org_id:        wo.org_id,
      quoted_amount,
      quote_notes,
    },
  })

  return NextResponse.json({ success: true })
}
