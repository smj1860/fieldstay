import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { workOrderRatelimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import type { WoStatus } from '@/types/database'

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

  // Insert vendor-submitted line items
  if (safeLineItems.length > 0) {
    await supabase.from('work_order_line_items').insert(
      safeLineItems.map((item, idx) => ({
        work_order_id:    claimed.id,
        org_id:           claimed.org_id,
        line_type:        item.line_type,
        description:      item.description.trim(),
        quantity:         item.quantity,
        unit_cost:        item.unit_cost,
        line_total:       Math.round(item.unit_cost * item.quantity * 100) / 100,
        sort_order:       idx,
        vendor_submitted: true,
      }))
    )
  }

  // Create invoice record if line items were submitted
  let invoiceId: string | null = null
  if (safeLineItems.length > 0 && claimed.vendor_id) {
    // Generate invoice number: INV-YYYY-NNNNN via an atomic Postgres sequence.
    // COUNT-then-INSERT is a TOCTOU race under concurrent submissions.
    const { data: seqResult, error: seqErr } = await supabase
      .rpc('next_work_order_invoice_seq')

    if (seqErr || seqResult == null) {
      console.error('[complete] invoice sequence error:', seqErr)
      return NextResponse.json({ error: 'Invoice numbering failed. Please try again.' }, { status: 500 })
    }

    const invoiceNumber = `INV-${new Date().getFullYear()}-${String(seqResult).padStart(5, '0')}`

    const platformFeePct = parseFloat(process.env.STRIPE_PLATFORM_FEE_PCT ?? '0') / 100
    const platformFee    = Math.round(subtotal * platformFeePct * 100) / 100

    const { data: invoice } = await supabase
      .from('work_order_invoices')
      .upsert(
        {
          org_id:              claimed.org_id,
          work_order_id:       claimed.id,
          vendor_id:           claimed.vendor_id,
          property_id:         claimed.property_id,
          invoice_number:      invoiceNumber,
          status:              'pending_payment',
          subtotal,
          total:               subtotal,
          platform_fee_amount: platformFee,
        },
        { onConflict: 'work_order_id', ignoreDuplicates: true }
      )
      .select('id')
      .single()

    if (invoice) {
      invoiceId = invoice.id
    } else {
      // UNIQUE(work_order_id) conflict — ignoreDuplicates means the upsert
      // inserted nothing, so fetch the existing invoice instead of dropping
      // the reference (never create a second invoice for the same WO).
      const { data: existing } = await supabase
        .from('work_order_invoices')
        .select('id')
        .eq('work_order_id', claimed.id)
        .single()
      invoiceId = existing?.id ?? null
    }
  }

  // Record status update
  await supabase.from('work_order_updates').insert({
    work_order_id:             claimed.id,
    org_id:                    claimed.org_id,
    updated_via_vendor_portal: true,
    status_from:               workOrder.status as WoStatus,
    status_to:                 'completed',
    notes,
  })

  // Fire Inngest event
  if (invoiceId) {
    await inngest.send({
      name: 'work-order/invoice-submitted',
      data: {
        work_order_id: claimed.id,
        invoice_id:    invoiceId,
        org_id:        claimed.org_id,
        vendor_id:     claimed.vendor_id!,
        property_id:   claimed.property_id,
        total:         subtotal,
      },
    })
  } else {
    // Legacy path (no line items) — existing portal completion event
    await inngest.send({
      name: 'work-order/completed-via-portal',
      data: {
        work_order_id:    claimed.id,
        completion_token: token,
        notes:            notes ?? null,
        photo_paths:      [],
      },
    })
  }

  // Fire turnover completion automation if this WO is linked to a turnover
  if (claimed.source_turnover_id) {
    const { data: turnover } = await supabase
      .from('turnovers')
      .select('id, property_id, org_id, status')
      .eq('id', claimed.source_turnover_id)
      .single()

    if (turnover && !['completed', 'cancelled'].includes(turnover.status)) {
      await inngest.send({
        name: 'turnover/completed',
        data: {
          turnover_id:          turnover.id,
          property_id:          turnover.property_id,
          org_id:               turnover.org_id,
          completed_by_crew_id: '',
          completed_at:         new Date().toISOString(),
        },
      })
    }
  }

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
