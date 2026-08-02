import { nullableArg } from '@/lib/supabase/rpc-args'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit, checkLimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import { finalizeVendorCompletion, type CompletionResult } from './helpers'
import { reportError } from '@/lib/observability/report-error'

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

  // Public, unauthenticated route — rate limit by IP before touching the DB.
  // Abuse/enumeration limiter → fails OPEN: a degraded limiter must never
  // block a legitimate contractor's submission.
  const rl = await checkLimit(workOrderRatelimit, `wo-complete:${extractClientIp(request) ?? 'unknown'}`, {
    onError: 'allow',
    site:    'route.work-orders.complete.POST',
  })
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
  }

  const supabase = createServiceClient({ publicSurface: 'api-work-orders--token--complete' })

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
  let notes:           string | null      = null
  let completedByName: string | null      = null
  // line_total is accepted on the wire because the existing vendor portal
  // sends it, but it is now IGNORED: complete_work_order_via_token() reads only
  // line_type/description/quantity/unit_cost, and work_order_line_items.line_total
  // is GENERATED ALWAYS AS (quantity * unit_cost). A client can no longer state
  // a line total that disagrees with its own quantity and unit cost.
  let lineItemsPayload: {
    line_type:   string
    description: string
    quantity:    number
    unit_cost:   number
    line_total?: number
  }[] = []
  let subtotal = 0

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({}))
    notes            = typeof body.notes === 'string' ? body.notes.trim() || null : null
    completedByName  = typeof body.completedByName === 'string' ? body.completedByName.trim() || null : null
    lineItemsPayload = Array.isArray(body.lineItems) ? body.lineItems : []
    subtotal         = typeof body.subtotal === 'number' ? body.subtotal : 0
  } else {
    const formData   = await request.formData()
    notes            = (formData.get('notes') as string | null)?.trim() || null
    completedByName  = (formData.get('completedByName') as string | null)?.trim() || null
  }

  if (!completedByName) {
    return NextResponse.json({ error: 'Technician name is required' }, { status: 400 })
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

  // ONE TRANSACTION. Every database write for this completion — the claim, the
  // invoice, the line items, the status-change row — happens inside
  // complete_work_order_via_token(), so either all of it lands or none does.
  //
  // This replaces an ordered saga (invoice first, then the claim, with
  // rollbackUnclaimedInvoice() compensating a lost claim). The ordering fixed
  // the catastrophic case but left three holes a compensating delete cannot
  // close: the rollback can itself fail, an invoice was briefly visible against
  // a not-yet-completed work order, and a failure after the sequence call burnt
  // an invoice number. See FUTURE_REMEDIATION.md #16.
  //
  // What stays HERE is everything that must not be rolled back by a later DB
  // failure, and must not fire from inside a transaction that might abort:
  // token validation, payload validation, the audit log, and event dispatch.
  const platformFeePct = Number.parseFloat(process.env.STRIPE_PLATFORM_FEE_PCT ?? '0') / 100

  const { data: rpcResult, error: rpcError } = await supabase.rpc('complete_work_order_via_token', {
    p_work_order_id:     workOrder.id,
    p_line_items:        safeLineItems,
    p_subtotal:          subtotal,
    // p_notes is a plain `text` parameter — NULL means "no notes given".
    p_notes:             nullableArg(notes),
    p_completed_by_name: completedByName,
    p_platform_fee_pct:  platformFeePct,
  })

  if (rpcError || !rpcResult) {
    console.error('[complete] completion transaction failed', rpcError)
    reportError(rpcError ?? new Error('complete_work_order_via_token returned no result'), {
      site: 'route.work-orders.complete.rpc',
    })
    return NextResponse.json({ error: 'Could not record completion. Please try again.' }, { status: 500 })
  }

  const result = rpcResult as CompletionResult

  if (!result.claimed) {
    // Nothing was written — the transaction rolled back in full, so unlike the
    // previous saga there is no invoice left behind to compensate for.
    return NextResponse.json({ error: 'Work order already closed' }, { status: 409 })
  }

  await finalizeVendorCompletion(supabase, {
    claimed:        result.work_order,
    invoiceId:      result.invoice_id,
    invoiceNumber:  result.invoice_number,
    invoiceInserted: result.invoice_inserted,
    subtotal,
    notes,
    token,
  })

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
  const supabase = createServiceClient({ publicSurface: 'api-work-orders--token--complete' })

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
