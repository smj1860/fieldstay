import { NextRequest, NextResponse }  from 'next/server'
import { requireOrgMember }           from '@/lib/auth'
import { stripe }                     from '@/lib/stripe/client'
import { createServiceClient }        from '@/lib/supabase/server'

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

  const supabase = createServiceClient()

  // Fetch invoice with vendor Connect details — scoped to PM's org
  const { data: invoice } = await supabase
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

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.status === 'paid') {
    return NextResponse.json({ error: 'Invoice already paid' }, { status: 409 })
  }

  if (invoice.status === 'cancelled') {
    return NextResponse.json({ error: 'Invoice is cancelled' }, { status: 409 })
  }

  const vendor = Array.isArray(invoice.vendors) ? invoice.vendors[0] : invoice.vendors

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
  const property         = Array.isArray(invoice.properties) ? invoice.properties[0] : invoice.properties
  const amountCents      = Math.round(invoice.total * 100)
  const feeCents         = Math.round(invoice.platform_fee_amount * 100)
  const platformFeePct   = parseFloat(process.env.STRIPE_PLATFORM_FEE_PCT ?? '0')

  // Recalculate fee fresh in case the env var changed since invoice creation
  const currentFeeCents = Math.round(amountCents * platformFeePct / 100)
  const finalFeeCents   = currentFeeCents > 0 ? currentFeeCents : feeCents

  const session = await stripe.checkout.sessions.create({
    mode:               'payment',
    success_url:        `${baseUrl}/invoices/${invoiceId}?paid=true`,
    cancel_url:         `${baseUrl}/invoices/${invoiceId}?cancelled=true`,
    payment_intent_data: {
      transfer_data: {
        destination: vendor.stripe_connect_account_id,
      },
      ...(finalFeeCents > 0 ? { application_fee_amount: finalFeeCents } : {}),
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
    ],
  })

  // Store the session ID for potential reuse on duplicate clicks
  await supabase
    .from('work_order_invoices')
    .update({ stripe_checkout_session_id: session.id })
    .eq('id', invoiceId)
    .eq('org_id', membership.org_id)

  return NextResponse.json({ url: session.url })
}
