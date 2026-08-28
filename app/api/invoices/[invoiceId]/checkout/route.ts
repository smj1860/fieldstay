import { unwrap } from '@/lib/supabase/unwrap'
import { NextRequest, NextResponse }  from 'next/server'
import { requireOrgMember }           from '@/lib/auth'
import { stripe }                     from '@/lib/stripe/client'
import { platformFeePct, processingSurchargeCents } from '@/lib/stripe/platform-fee'
import { createServiceClient }        from '@/lib/supabase/server'
import { logAuditEvent }              from '@/lib/audit'
import { unwrapJoin }                 from '@/lib/utils/supabase-joins'
import { reportError }                from '@/lib/observability/report-error'

/**
 * The error message for an invoice already past the point of a NEW Checkout
 * session, or null if it's still payable. Extracted so POST reads as one
 * guard rather than three sequential `if`s — each pushed cognitive
 * complexity up on its own, and 'refunded'/'partially_refunded' were the
 * addition that crossed the ratchet's limit.
 *
 * All three settled states return the same 409: a refunded invoice was
 * 'paid' a moment ago and would otherwise fall through into a brand-new
 * Checkout session — paid a second time by anyone who still has the link, or
 * by a stale Pay button the invoice page hadn't re-rendered yet.
 */
function invoiceSettledError(status: string): string | null {
  if (status === 'paid') return 'Invoice already paid'
  if (status === 'cancelled') return 'Invoice is cancelled'
  if (status === 'refunded' || status === 'partially_refunded') return 'Invoice has been refunded'
  return null
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> }
) {
  const { invoiceId } = await params

  let membership: Awaited<ReturnType<typeof requireOrgMember>>['membership']
  try {
    ({ membership } = await requireOrgMember())
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient({ authorizedBy: membership })

  // Fetch invoice with vendor Connect details — scoped to PM's org
  // A failed read used to render as 404 'Invoice not found', pointing the PM
  // at a missing invoice instead of a transient error.
  const invoiceRes = await supabase
    .from('work_order_invoices')
    .select(`
      id,
      status,
      total,
      platform_fee_amount,
      stripe_checkout_session_id,
      work_order_id,
      vendors (
        id,
        name,
        stripe_connect_account_id,
        stripe_connect_charges_enabled
      ),
      properties ( name )
    `)
    .eq('id', invoiceId)
    .eq('org_id', membership.org_id)
    .single()

  const invoice = unwrap(invoiceRes, { site: 'api.invoices.checkout', orgId: membership.org_id })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  const settledError = invoiceSettledError(invoice.status)
  if (settledError) {
    return NextResponse.json({ error: settledError }, { status: 409 })
  }

  const vendor = unwrapJoin(invoice.vendors)

  if (!vendor?.stripe_connect_account_id) {
    return NextResponse.json(
      { error: 'Vendor has not completed Stripe Connect onboarding yet.' },
      { status: 422 }
    )
  }

  if (!vendor.stripe_connect_charges_enabled) {
    return NextResponse.json(
      { error: 'Vendor\'s Stripe account is not yet active. They may need to complete onboarding.' },
      { status: 422 }
    )
  }

  // If a checkout session already exists and is still open, reuse it
  if (invoice.stripe_checkout_session_id) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(invoice.stripe_checkout_session_id)
      if (existing.status === 'open') {
        return NextResponse.json({ url: existing.url })
      }
    } catch {
      // Session expired or not found — create a new one below
    }
  }

  const baseUrl          = process.env.NEXT_PUBLIC_APP_URL!
  const property         = unwrapJoin(invoice.properties)
  const amountCents      = Math.round(invoice.total * 100)
  const feeCents         = Math.round(invoice.platform_fee_amount * 100)
  // Returns a FRACTION (0.03 for 3%), so no /100 here. Shared with the vendor
  // completion route so a malformed value cannot silently mean 0% on one path
  // and something else on the other — and so it is reported rather than
  // parsed inline into a NaN nobody sees.
  const feePct = platformFeePct()

  // Recalculate fee fresh in case the env var changed since invoice creation
  const currentFeeCents = Math.round(amountCents * feePct)
  const finalFeeCents   = currentFeeCents > 0 ? currentFeeCents : feeCents

  // Card processing, passed to the payer.
  //
  // This is a DESTINATION charge, so Stripe's cut comes out of the platform
  // balance. Before this, the platform's net was `application_fee − stripe's
  // cut`, which at a 3% platform fee is negative below a $300 invoice — most
  // vendor invoices. See lib/stripe/platform-fee.ts for the arithmetic.
  //
  // Three numbers have to move together or the money goes to the wrong party:
  //
  //   charged to PM  = amount + surcharge      (a SEPARATE line item, below)
  //   application fee = platform fee + surcharge
  //   vendor receives = charged − application fee = amount − platform fee
  //
  // i.e. the vendor's payout is byte-for-byte what it was; the surcharge is
  // routed to the platform to cancel out what Stripe takes from it. Raising
  // the line item WITHOUT raising the application fee would silently hand the
  // surcharge to the vendor — the PM pays more and the platform still nets
  // nothing, which is the failure this whole change exists to remove.
  // unit/stripe/processing-surcharge.test.ts pins all three.
  const surchargeCents         = processingSurchargeCents(amountCents)
  const feeWithProcessingCents = finalFeeCents + surchargeCents

  const session = await stripe.checkout.sessions.create({
    mode:               'payment',
    success_url:        `${baseUrl}/invoices/${invoiceId}?paid=true`,
    cancel_url:         `${baseUrl}/invoices/${invoiceId}?cancelled=true`,
    payment_intent_data: {
      transfer_data: {
        destination: vendor.stripe_connect_account_id,
      },
      ...(feeWithProcessingCents > 0 ? { application_fee_amount: feeWithProcessingCents } : {}),
      metadata: {
        invoice_id:     invoiceId,
        work_order_id:  invoice.work_order_id,
        org_id:         membership.org_id,
        vendor_id:      vendor.id,
      },
    },
    metadata: {
      invoice_id:    invoiceId,
      work_order_id: invoice.work_order_id,
      org_id:        membership.org_id,
    },
    line_items: [
      {
        price_data: {
          currency:     'usd',
          unit_amount:  amountCents,
          product_data: {
            name:        `Invoice ${invoiceId.slice(-8).toUpperCase()}`,
            description: `Work order payment — ${property?.name ?? 'Property'}`,
          },
        },
        quantity: 1,
      },
      // Its own line, not folded into the amount above. A surcharge a payer
      // cannot see is a surcharge they dispute, and the invoice page shows the
      // same two numbers — a Checkout total that disagrees with the page the
      // customer clicked Pay on is its own support ticket.
      ...(surchargeCents > 0 ? [{
        price_data: {
          currency:     'usd',
          unit_amount:  surchargeCents,
          product_data: {
            name:        'Card processing fee',
            description: 'Charged by our payment processor and passed through at cost',
          },
        },
        quantity: 1,
      }] : []),
    ],
  })

  // Store the session ID for potential reuse on duplicate clicks
  const { error: cacheSessionErr } = await supabase
    .from('work_order_invoices')
    .update({ stripe_checkout_session_id: session.id })
    .eq('id', invoiceId)
    .eq('org_id', membership.org_id)

  if (cacheSessionErr) {
    console.error('[invoices/checkout] failed to cache session id', cacheSessionErr)
    reportError(cacheSessionErr, {
      site:  'api.invoices.checkout.cacheSession',
      orgId: membership.org_id,
    })
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    action:     'work_order.invoice.checkout_started',
    targetType: 'work_order_invoice',
    targetId:   invoiceId,
  })

  return NextResponse.json({ url: session.url })
}
