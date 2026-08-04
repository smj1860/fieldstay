import { nullableArg } from '@/lib/supabase/rpc-args'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit, checkLimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import { finalizeVendorCompletion, type CompletionResult } from './helpers'
import { reportError } from '@/lib/observability/report-error'
import { platformFeePct } from '@/lib/stripe/platform-fee'
import { tryUnwrap } from '@/lib/supabase/unwrap'

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

  // Validate token.
  //
  // tryUnwrap, not `const { data } = await …`: destructuring data alone
  // collapsed "the query errored" and "no such token" into the same null, so
  // any DB failure — pool exhaustion, statement timeout, a Supabase blip —
  // told the contractor their link was invalid, with nothing logged and
  // nothing reported. They abandon the submission or call the PM, who then
  // tests the same link successfully and finds nothing wrong. An outage on
  // the vendor completion path was invisible in monitoring and misattributed
  // to token expiry by the only person who ever saw it.
  const workOrderRes = await supabase
    .from('work_orders')
    .select('id, org_id, property_id, vendor_id, status, portal_enabled, completion_token_expires_at')
    .eq('completion_token', token)
    .maybeSingle()

  const lookup = tryUnwrap(workOrderRes, { site: 'route.work-orders.complete.token' })
  if (!lookup.ok) {
    return NextResponse.json(
      { error: 'Service temporarily unavailable. Please try again.' },
      { status: 503 },
    )
  }

  const workOrder = lookup.data
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
    const vendorRes = await supabase
      .from('vendors')
      .select('org_id')
      .eq('id', workOrder.vendor_id)
      .maybeSingle()

    // Same reason as the token lookup above: a failed query must not be
    // reported as an authorization decision. Failing closed here was at least
    // safe, but it told the contractor they were "not authorized" for what was
    // actually an outage — and logged nothing either way.
    const vendorLookup = tryUnwrap(vendorRes, { site: 'route.work-orders.complete.vendor' })
    if (!vendorLookup.ok) {
      return NextResponse.json(
        { error: 'Service temporarily unavailable. Please try again.' },
        { status: 503 },
      )
    }

    if (!vendorLookup.data || vendorLookup.data.org_id !== workOrder.org_id) {
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
  // `subtotal` is deliberately NOT read from the body any more — see the
  // derivation block below for why the previous fallback was reachable only
  // by the payload shape it was meant to exclude.

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({}))
    notes            = typeof body.notes === 'string' ? body.notes.trim() || null : null
    completedByName  = typeof body.completedByName === 'string' ? body.completedByName.trim() || null : null
    lineItemsPayload = Array.isArray(body.lineItems) ? body.lineItems : []
  } else {
    const formData   = await request.formData()
    notes            = (formData.get('notes') as string | null)?.trim() || null
    completedByName  = (formData.get('completedByName') as string | null)?.trim() || null
  }

  if (!completedByName) {
    return NextResponse.json({ error: 'Technician name is required' }, { status: 400 })
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

  // ── The invoice total is DERIVED, never accepted ────────────────────────
  //
  // `line_total` is a GENERATED ALWAYS column precisely so a client cannot
  // state a line total that disagrees with its own quantity × unit cost. That
  // control was then defeated one level up: `subtotal` came straight from the
  // request body, bounded only on the upside, and was written to
  // work_orders.actual_cost, work_order_invoices.subtotal/.total and the
  // Stripe platform fee. This is the only UNAUTHENTICATED path in the app that
  // mints financial records.
  //
  // It was wrong in both directions, and the non-adversarial direction is the
  // likelier one: a submission whose third line item fails validation drops
  // that item from safeLineItems but left it counted in `subtotal`, so the
  // stored invoice total silently exceeded the sum of the items printed
  // beneath it. Adversarially, $50 of line items with `subtotal: 999999` was
  // simply accepted, as was a negative value (which passed the `> 1_000_000`
  // check and produced a negative platform fee).
  //
  // The first fix kept a `safeLineItems.length > 0 ? derived : subtotal`
  // fallback, justified as serving "the legacy no-line-items path". It served
  // the opposite: the legacy FormData branch never assigns `subtotal` at all
  // (it stayed 0), so the client's figure could ONLY be reached by a JSON
  // submission whose line items had all failed validation — `lineItems: []`,
  // or a set where every entry was rejected. The one control on the app's only
  // unauthenticated money-minting path was bypassed by supplying nothing to
  // derive from, and `p_subtotal` writes work_orders.actual_cost
  // unconditionally (the RPC's `IF v_has_line_items` guard covers only the
  // invoice). From there it posts to owner_transactions under an
  // `ignoreDuplicates` upsert, so the first value written is the owner's P&L
  // permanently — there is no correcting write.
  //
  // So the total is now DERIVED with no fallback. The legacy path derives 0,
  // which leaves actual_cost untouched (`CASE WHEN p_subtotal > 0`) — exactly
  // the behaviour it had before, since its `subtotal` was always 0 anyway.
  const derivedSubtotal = safeLineItems.reduce(
    (sum, item) => sum + item.quantity * item.unit_cost,
    0,
  )
  // cents; avoids FP dust reaching money columns
  const effectiveSubtotal = Math.round(derivedSubtotal * 100) / 100

  // Items were submitted and every one was rejected. The portal filters to
  // `validItems` and refuses to submit an empty set, so this is a malformed or
  // hand-crafted payload rather than anything the real client produces —
  // and it is the exact shape that used to reach the `subtotal` fallback.
  if (lineItemsPayload.length > 0 && safeLineItems.length === 0) {
    return NextResponse.json(
      { error: 'No valid line items. Each needs a type, description, quantity > 0 and unit cost > 0.' },
      { status: 400 },
    )
  }

  // A partial drop stays accepted — the portal's own filter is looser than
  // this one (it does not check quantity), so rejecting outright would fail
  // real submissions, including ones already queued in a vendor's offline
  // outbox under an older build. But it must not stay SILENT: the derived
  // total and the stored line items now agree with each other, while the
  // vendor still believes they billed for the dropped row.
  if (safeLineItems.length !== lineItemsPayload.length) {
    reportError(
      new Error('Vendor completion dropped invalid line items'),
      {
        site:  'route.work-orders.complete.line_items_dropped',
        extra: {
          work_order_id: workOrder.id,
          submitted:     lineItemsPayload.length,
          accepted:      safeLineItems.length,
        },
      },
    )
  }

  if (!Number.isFinite(effectiveSubtotal) || effectiveSubtotal < 0) {
    return NextResponse.json({ error: 'Invoice total is not a valid amount.' }, { status: 400 })
  }

  // Sanity bound — catches a typo (an extra zero) or a malicious payload
  // before it becomes actual_cost/an invoice amount. Applied to the DERIVED
  // value so a pile of line items cannot exceed it either.
  if (effectiveSubtotal > 1_000_000) {
    return NextResponse.json({ error: 'Invoice total must be under $1,000,000. Please check your entries.' }, { status: 400 })
  }

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
  // Validated + reported rather than parsed inline: a malformed value used to
  // become NaN here, serialize to JSON null, and get COALESCEd to a 0% fee on
  // every invoice with nothing logged anywhere.
  const feePct = platformFeePct()

  const { data: rpcResult, error: rpcError } = await supabase.rpc('complete_work_order_via_token', {
    p_work_order_id:     workOrder.id,
    p_line_items:        safeLineItems,
    p_subtotal:          effectiveSubtotal,
    // p_notes is a plain `text` parameter — NULL means "no notes given".
    p_notes:             nullableArg(notes),
    p_completed_by_name: completedByName,
    p_platform_fee_pct:  feePct,
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
    subtotal: effectiveSubtotal,
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

  // Same conflation as POST: without separating the error from the empty
  // result, an outage renders the vendor portal page as "Not found".
  const workOrderRes = await supabase
    .from('work_orders')
    .select(`
      id, title, description, status, portal_enabled,
      completion_token_expires_at,
      properties (name, city, state)
    `)
    .eq('completion_token', token)
    .maybeSingle()

  const lookup = tryUnwrap(workOrderRes, { site: 'route.work-orders.complete.token.GET' })
  if (!lookup.ok) {
    return NextResponse.json(
      { error: 'Service temporarily unavailable. Please try again.' },
      { status: 503 },
    )
  }

  const workOrder = lookup.data
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
