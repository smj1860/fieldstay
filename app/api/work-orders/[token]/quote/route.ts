import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient }       from '@/lib/supabase/server'
import { inngest }                   from '@/lib/inngest/client'
import { workOrderRatelimit, checkLimit } from '@/lib/rate-limit'
import { extractClientIp }           from '@/lib/integrations/webhook-verification'
import { unwrapJoin }                from '@/lib/utils/supabase-joins'
import { reportError }               from '@/lib/observability/report-error'
import { isRealQueryError, throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

// Public, unauthenticated, token-gated route — rate limit by IP so a
// leaked/enumerated token can't drive unbounded repeated lookups or
// submissions. Abuse/enumeration limiter → fails OPEN.
async function checkRateLimit(request: NextRequest, key: string): Promise<NextResponse | null> {
  const decision = await checkLimit(workOrderRatelimit, `${key}:${extractClientIp(request) ?? 'unknown'}`, {
    onError: 'allow',
    site:    `route.work-orders.quote.${key}`,
  })
  if (!decision.allowed) {
    return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
  }
  return null
}

// L-5: the previous inline `new Date(qr.quote_token_expires_at) < new Date()`
// silently mis-reads a missing expiry. `new Date(undefined)` is Invalid Date,
// and EVERY relational comparison against Invalid Date is false — so an
// absent value read as "not expired", i.e. an unbounded token. (A literal
// null happens to coerce to 1970 and read as expired, so the two absent-value
// shapes disagree with each other, which is worse than either alone.)
// types/database.ts types this column non-null and the schema declares it
// NOT NULL, but this route is the unauthenticated token gate — it must not
// depend on that invariant holding to stay safe. Absent or unparseable ⇒
// expired: a quote request with no usable expiry is malformed, not eternal.
function isQuoteTokenExpired(expiresAt: string | null | undefined): boolean {
  if (expiresAt === null || expiresAt === undefined) return true
  const expiry = new Date(expiresAt)
  if (Number.isNaN(expiry.getTime())) return true
  return expiry < new Date()
}

const MAX_QUOTE_AMOUNT = 1_000_000   // $1M — the per-quote ceiling, enforced on the DERIVED total
const MAX_LINE_ITEMS   = 100
const MAX_DESCRIPTION  = 300
const VALID_LINE_TYPES = new Set(['labor', 'material', 'equipment', 'subcontractor', 'other'])

interface QuoteLineItemInput {
  line_type:   string
  description: string
  quantity:    number
  unit:        string | null
  unit_cost:   number
}

/**
 * Validates the vendor's line items at the boundary.
 *
 * Deliberately REJECTS a malformed item rather than filtering it out. The
 * completion route learned this the hard way in the opposite direction: it
 * dropped invalid items from the insert while still counting them in the
 * total, so the stored invoice exceeded the sum of the lines printed beneath
 * it. Here the total is derived from what was actually stored, so silently
 * dropping a line would instead under-quote the vendor — they would see a
 * total lower than what they typed, on a figure they are then held to. Neither
 * failure mode is acceptable; refusing the whole submission with a specific
 * message is.
 */
function parseQuoteLineItems(raw: unknown): { value: QuoteLineItemInput[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Add at least one line item with a description and cost.' }
  }
  if (raw.length > MAX_LINE_ITEMS) {
    return { error: `A quote can have at most ${MAX_LINE_ITEMS} line items.` }
  }

  const value: QuoteLineItemInput[] = []

  for (const [i, item] of raw.entries()) {
    const label = `Line ${i + 1}`
    if (typeof item !== 'object' || item === null) {
      return { error: `${label} is not a valid line item.` }
    }
    const row = item as Record<string, unknown>

    const description = typeof row.description === 'string' ? row.description.trim() : ''
    if (!description) return { error: `${label} needs a description.` }
    if (description.length > MAX_DESCRIPTION) {
      return { error: `${label}'s description must be under ${MAX_DESCRIPTION} characters.` }
    }

    // Number.isFinite rejects NaN and Infinity, which `> 0` alone does not:
    // NaN fails every comparison silently and JSON.stringify turns it back
    // into null on the way to the database.
    const quantity = typeof row.quantity === 'number' ? row.quantity : Number.NaN
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { error: `${label} needs a quantity greater than zero.` }
    }

    const unitCost = typeof row.unit_cost === 'number' ? row.unit_cost : Number.NaN
    if (!Number.isFinite(unitCost) || unitCost <= 0) {
      return { error: `${label} needs a unit cost greater than zero.` }
    }

    const lineType = typeof row.line_type === 'string' ? row.line_type : ''
    if (!VALID_LINE_TYPES.has(lineType)) {
      return { error: `${label} has an unrecognized type.` }
    }

    const unit = typeof row.unit === 'string' ? row.unit.trim().slice(0, 20) || null : null

    value.push({ line_type: lineType, description, quantity, unit, unit_cost: unitCost })
  }

  return { value }
}

/** Return shape of the `submit_quote_via_token(text, jsonb, text, numeric)` RPC. */
type SubmitQuoteResult =
  | {
      ok: true
      quote_request_id: string
      work_order_id:    string
      org_id:           string
      quoted_amount:    number
      line_item_count:  number
    }
  | { ok: false; reason: 'no_line_items' | 'not_found' | 'not_pending' | 'expired' }

const QUOTE_SUBMIT_FAILURES: Record<string, { status: number; message: string }> = {
  no_line_items: { status: 400, message: 'Add at least one line item with a description and cost.' },
  not_found:     { status: 404, message: 'Invalid or expired link' },
  not_pending:   { status: 409, message: 'This quote request is no longer active' },
  expired:       { status: 410, message: 'This quote link has expired' },
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = await checkRateLimit(request, 'wo-quote-get')
  if (rateLimited) return rateLimited

  const { token }  = await params
  const supabase   = createServiceClient({ publicSurface: 'api-work-orders--token--quote' })

  const { data: qr, error: qrError } = await supabase
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

  if (isRealQueryError(qrError)) {
    throwIfAnyQueryFailed({ site: 'route.work-orders.quote.GET' }, qrError)
  }
  if (!qr) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (isQuoteTokenExpired(qr.quote_token_expires_at)) {
    return NextResponse.json({ error: 'This quote link has expired' }, { status: 410 })
  }

  const wo = unwrapJoin(qr.work_orders)

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
  const supabase   = createServiceClient({ publicSurface: 'api-work-orders--token--quote' })

  const body = await request.json().catch(() => ({})) as {
    items?: unknown
    notes?: unknown
  }

  const items = parseQuoteLineItems(body.items)
  if ('error' in items) {
    return NextResponse.json({ error: items.error }, { status: 400 })
  }

  const quote_notes = typeof body.notes === 'string' ? body.notes.trim() || null : null

  // ONE transaction: claim the quote, insert its line items, derive the total,
  // log the update. The previous shape was an UPDATE followed by two more
  // writes; with line items in the picture, a failure between them would leave
  // a quote reading `submitted` at some amount with no itemization behind it —
  // and permanently, because the claim is `WHERE status = 'pending'`, so the
  // vendor's retry is refused as already-submitted.
  //
  // The TOTAL IS NEVER ACCEPTED FROM THE CLIENT. quoted_amount is SUM over the
  // GENERATED ALWAYS line_total column of the rows the function just inserted.
  // Every expiry and status check lives inside the same transaction too, so
  // there is no window between checking and claiming.
  const { data: rpcResult, error: rpcError } = await supabase.rpc('submit_quote_via_token', {
    p_quote_token: token,
    // Rebuilt as a fresh object literal rather than passed as QuoteLineItemInput[]:
    // the RPC parameter is typed `Json`, which a named interface cannot satisfy
    // (no index signature). The alternative is an `as unknown as Json` double
    // assertion, which would suppress a real mismatch as readily as this one.
    p_line_items:  items.value.map((i) => ({
      line_type:   i.line_type,
      description: i.description,
      quantity:    i.quantity,
      unit:        i.unit,
      unit_cost:   i.unit_cost,
    })),
    // '' rather than null: the generated RPC parameter type is non-nullable.
    // submit_quote_via_token normalises it back with NULLIF(btrim(...), ''),
    // so the column still holds NULL for "no note" and never an empty string.
    p_notes:       quote_notes ?? '',
    p_max_total:   MAX_QUOTE_AMOUNT,
  })

  if (rpcError) {
    // 23514 is the function's own total-exceeds-maximum guard, raised (rather
    // than returned) so the inserted rows roll back with it. It is a client
    // input problem, not an outage.
    if (rpcError.code === '23514') {
      return NextResponse.json(
        { error: `Quote total must be under $${MAX_QUOTE_AMOUNT.toLocaleString()}. Please check your entries.` },
        { status: 400 },
      )
    }
    reportError(rpcError, { site: 'route.work-orders.quote.POST' })
    return NextResponse.json({ error: 'Service temporarily unavailable. Please try again.' }, { status: 503 })
  }

  const result = rpcResult as SubmitQuoteResult | null

  if (!result?.ok) {
    const failure = QUOTE_SUBMIT_FAILURES[result?.reason ?? 'not_found']
    return NextResponse.json({ error: failure.message }, { status: failure.status })
  }

  await inngest.send({
    name: 'work-order/quote-submitted' as const,
    data: {
      work_order_id:    result.work_order_id,
      quote_request_id: result.quote_request_id,
      org_id:           result.org_id,
      quoted_amount:    result.quoted_amount,
      quote_notes,
    },
  })

  return NextResponse.json({
    success:       true,
    quotedAmount:  result.quoted_amount,
    lineItemCount: result.line_item_count,
  })
}
