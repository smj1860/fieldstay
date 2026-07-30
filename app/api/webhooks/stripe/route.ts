import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe/client'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'
import { handleWorkOrderInvoicePaid } from './handlers/work-order-invoice'
import {
  handleSponsorCheckoutCompleted,
  handleSponsorSubscriptionCancelled,
  handleSponsorPaymentFailed,
  handleSponsorPaymentRecovered,
} from './handlers/guidebook-sponsor'
import {
  handleRepuguardSubscriptionUpdated,
  handleRepuguardSubscriptionCancelled,
} from './handlers/repuguard-subscription'
import {
  handleCheckoutSessionBilling,
  handleCoreSubscriptionUpdate,
  handleCoreSubscriptionCancelled,
} from './handlers/core-billing'

export async function POST(request: NextRequest) {
  const body      = await request.text()
  const signature = request.headers.get('stripe-signature')

  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  let event
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err)
    reportError(err, { site: 'webhook.stripe.signature_verification' })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const supabase = createServiceClient({ publicSurface: 'api-webhooks-stripe' })

  // Deduplicate — Stripe delivers webhooks at-least-once
  const { error: dedupErr } = await supabase
    .from('stripe_processed_events')
    .insert({ stripe_event_id: event.id })
  if (dedupErr) {
    if (dedupErr.code === '23505') {
      return NextResponse.json({ received: true })
    }
    console.error('[Stripe] dedup insert failed (non-fatal):', dedupErr.message)
    reportError(new Error(dedupErr.message), { site: 'webhook.stripe.dedup_insert', extra: { stripe_event_id: event.id } })
  }

  try {
    await routeStripeEvent(supabase, event)
  } catch (err) {
    // A handler threw — the dedup row for this event.id was already
    // committed above, so Stripe's retry (same event.id, at-least-once
    // delivery) would otherwise hit the 23505 branch and be silently
    // discarded as "already processed" even though nothing actually
    // completed. Release the claim so the retry gets a real second
    // attempt. Mirrors app/api/webhooks/[provider]/route.ts's identical
    // fix for provider webhooks.
    console.error(`[Stripe] Handler threw for event ${event.id} (${event.type}):`, err)
    reportError(err, { site: 'webhook.stripe.handler', extra: { stripe_event_id: event.id, event_type: event.type } })

    const { error: releaseErr } = await supabase
      .from('stripe_processed_events')
      .delete()
      .eq('stripe_event_id', event.id)

    if (releaseErr) {
      console.error(`[Stripe] Failed to release dedup claim for ${event.id}:`, releaseErr.message)
      reportError(new Error(releaseErr.message), {
        site:  'webhook.stripe.dedup_release',
        extra: { stripe_event_id: event.id },
      })
    }

    // Let Stripe see the failure and retry per its own schedule.
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}


type ServiceClient = ReturnType<typeof createServiceClient>
type StripeEvent   = ReturnType<typeof stripe.webhooks.constructEvent>

// Each event family gets its own named function. The switch used to inline all
// five, which put every branch of every family into one 35-complexity handler.
async function routeStripeEvent(supabase: ServiceClient, event: StripeEvent): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await onCheckoutSessionCompleted(supabase, event.data.object)
      return

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await onSubscriptionUpserted(supabase, event)
      return

    case 'customer.subscription.deleted':
      await onSubscriptionDeleted(supabase, event.data.object)
      return

    case 'invoice.payment_failed':
      await onInvoicePaymentFailed(event.data.object)
      return

    case 'invoice.payment_succeeded':
      await onInvoicePaymentSucceeded(event.data.object)
      return

    default:
      // Unhandled event type — ignore
      return
  }
}

type CheckoutSession = Extract<StripeEvent, { type: 'checkout.session.completed' }>['data']['object']

async function onCheckoutSessionCompleted(supabase: ServiceClient, session: CheckoutSession): Promise<void> {
  const invoiceId  = session.metadata?.invoice_id
  const orgId      = session.metadata?.org_id
  const customerId = typeof session.customer === 'string' ? session.customer : null

  if (invoiceId && orgId) {
    await handleWorkOrderInvoicePaid(supabase, session, invoiceId, orgId)
    return
  }

  if (session.metadata?.feature === 'guidebook_sponsor') {
    await handleSponsorCheckoutCompleted(session)
    return
  }

  if (orgId && customerId) {
    await handleCheckoutSessionBilling(supabase, orgId, customerId)
    return
  }

  console.error(
    '[Stripe] checkout.session.completed missing org_id or customer',
    { sessionId: session.id }
  )
  reportError(new Error('checkout.session.completed missing org_id or customer'), {
    site:  'webhook.stripe.checkout_session_completed',
    extra: { stripe_session_id: session.id },
  })
}

async function onSubscriptionUpserted(
  supabase: ServiceClient,
  event:    Extract<StripeEvent, { type: 'customer.subscription.created' | 'customer.subscription.updated' }>,
): Promise<void> {
  const subscription = event.data.object

  if (subscription.metadata?.feature === 'repuguard') {
    await handleRepuguardSubscriptionUpdated(supabase, subscription, event.type)
    return
  }

  const previousAttributes = event.data.previous_attributes as Partial<{ status: string }> | undefined
  await handleCoreSubscriptionUpdate(supabase, subscription, event.type, previousAttributes?.status)
}

type DeletedSubscription = Extract<StripeEvent, { type: 'customer.subscription.deleted' }>['data']['object']

async function onSubscriptionDeleted(supabase: ServiceClient, subscription: DeletedSubscription): Promise<void> {
  if (subscription.metadata?.feature === 'repuguard') {
    await handleRepuguardSubscriptionCancelled(supabase, subscription, 'customer.subscription.deleted')
    return
  }

  if (subscription.metadata?.feature === 'guidebook_sponsor') {
    await handleSponsorSubscriptionCancelled(subscription)
    return
  }

  await handleCoreSubscriptionCancelled(supabase, subscription, subscription.customer as string)
}

type StripeInvoice = Extract<StripeEvent, { type: 'invoice.payment_failed' }>['data']['object']

async function onInvoicePaymentFailed(invoice: StripeInvoice): Promise<void> {
  const subId = invoice.subscription as string | null
  if (!subId) return

  const subscription = await stripe.subscriptions.retrieve(subId)
  if (subscription.metadata?.feature === 'guidebook_sponsor') {
    await handleSponsorPaymentFailed(subscription)
  }
}

async function onInvoicePaymentSucceeded(
  invoice: Extract<StripeEvent, { type: 'invoice.payment_succeeded' }>['data']['object'],
): Promise<void> {
  const subId = invoice.subscription as string | null
  if (!subId) return

  // Early exit: avoid Stripe API call for non-sponsor invoices.
  // Only guidebook sponsor subscriptions contain this price ID.
  const hasSponsorLine = (invoice.lines?.data ?? []).some(
    (line) => line.price?.id === process.env.STRIPE_PRICE_SPONSOR_MONTHLY
  )
  if (!hasSponsorLine) return

  const subscription = await stripe.subscriptions.retrieve(subId)
  if (subscription.metadata?.feature === 'guidebook_sponsor') {
    await handleSponsorPaymentRecovered(subscription)
  }
}
