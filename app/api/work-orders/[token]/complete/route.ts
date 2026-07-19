import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import type { WoStatus } from '@/types/database'
import { createVendorInvoice, dispatchCompletionEvents } from './helpers'

/**
 * POST /api/work-orders/[token]/complete
 *
 * Public endpoint — no auth required.
 * Vendor submits completion via their tokenized portal link.
 *
 * Body: JSON (line items + invoice — new flow) or FormData (legacy, notes only)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  // Public, unauthenticated route — rate limit by IP before touching the
  // DB. Fails open on a Redis outage; a degraded limiter must never block
  // a legitimate contractor's submission.
  try {
    const ip = extractClientIp(request) ?? 'unknown'
    const { success } = await workOrderRatelimit.limit(`wo-complete:${ip}`)
    if (!success) {
      return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
    }
  } catch (rlErr) {
    console.error('[work-orders/complete] rate limit check failed', rlErr)
  }

  const supabase = createServiceClient()

  // Validate token
  const { data: workOrder } = await supabase
    .from('work_orders')
    .select('id, org_id, property_id, vendor_id, status, portal_enabled, completion_token_expires_at')
    .eq('completion_token', token)
    .single()

  if (!workOrder) {
    return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
  }

  if (!workOrder.portal_enabled) {
    return NextResponse.json({ error: 'Vendor portal not enabled for this work order' }, { status: 403 })
  }

  if (workOrder.status === 'completed' || workOrder.status === 'cancelled') {
    return NextResponse.json({ error: 'Work order already closed' }, { status: 409 })
  }

  if (
    workOrder.completion_token_expires_at &&
    new Date(workOrder.completion_token_expires_at) < new Date()
  ) {
    return NextResponse.json({ error: 'Link has expired' }, { status: 410 })
  }

  // Verify the assigned vendor's org matches the work order's org before any
  // invoice record can be created against it.
  if (workOrder.vendor_id) {
    const { data: vendorRow } = await supabase
      .from('vendors')
      .select('org_id')
      .eq('id', workOrder.vendor_id)
      .single()

    if (!vendorRow || vendorRow.org_id !== workOrder.org_id) {
      return NextResponse.json({ error: 'Vendor not authorized for this work order' }, { status: 403 })
    }
  }

  // Parse body — supports both JSON (new line items flow) and FormData (legacy)
  const contentType = request.headers.get('content-type') ?? ''
  let notes:     string | null            = null
  let lineItemsPayload: {
    line_type:   string
    description: string
    quantity:    number
    unit_cost:   number
    line_total:  number
  }[] = []
  let subtotal = 0

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({}))
    notes          = typeof body.notes === 'string' ? body.notes.trim() || null : null
    lineItemsPayload = Array.isArray(body.lineItems) ? body.lineItems : []
    subtotal       = typeof body.subtotal === 'number' ? body.subtotal : 0
  } else {
    const formData = await request.formData()
    notes          = (formData.get('notes') as string | null)?.trim() || null
  }

  // Sanity bound on the submitted total — catches a typo (an extra zero) or
  // a malicious payload before it becomes actual_cost/an invoice amount.
  if (subtotal > 1_000_000) {
    return NextResponse.json({ error: 'Invoice total must be under $1,000,000. Please check your entries.' }, { status: 400 })
  }

  // Validate line items if provided
  const VALID_LINE_TYPES = new Set(['labor', 'material', 'equipment', 'subcontractor', 'other'])
  const safeLineItems = lineItemsPayload.filter((item) =>
    VALID_LINE_TYPES.has(item.line_type) &&
    typeof item.description === 'string' &&
    item.description.trim().length > 0 &&
    typeof item.unit_cost === 'number' && item.unit_cost > 0 &&
    typeof item.quantity === 'number' && item.quantity > 0
  )

  // Atomically claim the completion — only succeeds once
  const { data: claimed } = await supabase
    .from('work_orders')
    .update({
      status:           'completed',
      completed_date:   new Date().toISOString().split('T')[0],
      completion_notes: notes,
      actual_cost:      subtotal > 0 ? subtotal : undefined,
    })
    .eq('id', workOrder.id)
    .in('status', ['pending', 'assigned', 'in_progress'])
    .select('id, org_id, vendor_id, property_id, wo_number, source_turnover_id')
    .single()

  if (!claimed) {
    return NextResponse.json({ error: 'Work order already closed' }, { status: 409 })
  }

  const invoiceResult = await createVendorInvoice(supabase, claimed, safeLineItems, subtotal)
  if (!invoiceResult.ok) {
    return NextResponse.json({ error: invoiceResult.error }, { status: 500 })
  }
  const invoiceId = invoiceResult.invoiceId

  // Record status update
  await supabase.from('work_order_updates').insert({
    work_order_id:             claimed.id,
    org_id:                    claimed.org_id,
    updated_via_vendor_portal: true,
    status_from:               workOrder.status as WoStatus,
    status_to:                 'completed',
    notes,
  })

  await dispatchCompletionEvents(supabase, claimed, invoiceId, token, notes, subtotal)

  return NextResponse.json({ success: true })
}

/**
 * GET /api/work-orders/[token]/complete
 *
 * Returns basic work order info so the vendor portal UI
 * can render the form before submission.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: workOrder } = await supabase
    .from('work_orders')
    .select(`
      id, title, description, status, portal_enabled,
      completion_token_expires_at,
      properties (name, city, state)
    `)
    .eq('completion_token', token)
    .single()

  if (!workOrder || !workOrder.portal_enabled) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Expiry check — matches POST handler behaviour
  if (
    workOrder.completion_token_expires_at &&
    new Date(workOrder.completion_token_expires_at) < new Date()
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json({ workOrder })
}
