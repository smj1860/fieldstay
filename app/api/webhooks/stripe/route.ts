import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe/client'
import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { PLANS, getPlanByPriceId, type PlanKey } from '@/lib/stripe/client'
import { logAuditEvent } from '@/lib/audit'

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
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Deduplicate — Stripe delivers webhooks at-least-once
  const { error: dedupErr } = await supabase
    .from('stripe_processed_events')
    .insert({ stripe_event_id: event.id })
  if (dedupErr) {
    if (dedupErr.code === '23505') {
      return NextResponse.json({ received: true })
    }
    console.error('[Stripe] dedup insert failed (non-fatal):', dedupErr.message)
  }

  switch (event.type) {

    case 'checkout.session.completed': {
      const session    = event.data.object
      const orgId      = session.metadata?.org_id
      const customerId = typeof session.customer === 'string'
        ? session.customer
        : null

      if (!orgId || !customerId) {
        console.error(
          '[Stripe] checkout.session.completed missing org_id or customer',
          { sessionId: session.id }
        )
        break
      }

      await supabase
        .from('organizations')
        .update({ stripe_customer_id: customerId })
        .eq('id', orgId)
        .is('stripe_customer_id', null)

      break
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = event.data.object

      // RepuGuard-specific subscription update
      if (subscription.metadata?.feature === 'repuguard') {
        const orgId = subscription.metadata?.org_id
        if (orgId) {
          const repuguardStatus =
            subscription.status === 'active'   ? 'active'
          : subscription.status === 'trialing' ? 'trial'
          : subscription.status === 'past_due' ? 'active'
          : 'cancelled'

          await supabase
            .from('organizations')
            .update({ repuguard_status: repuguardStatus })
            .eq('id', orgId)
        }
        break
      }

      const customerId   = subscription.customer as string
      const priceId      = subscription.items.data[0]?.price.id ?? ''
      const planKey      = getPlanByPriceId(priceId) ?? 'pro'
      const plan         = planKey as PlanKey

      const planStatus = subscription.status === 'active'   ? 'active'
                       : subscription.status === 'trialing' ? 'trialing'
                       : subscription.status === 'past_due' ? 'past_due'
                       : 'cancelled'

      // Find the org by Stripe customer ID
      const { data: org } = await supabase
        .from('organizations')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .single()

      if (org) {
        await supabase
          .from('organizations')
          .update({
            stripe_subscription_id: subscription.id,
            plan,
            plan_status:     planStatus,
            max_properties:  PLANS[plan].maxProperties,
            trial_ends_at:   subscription.trial_end
              ? new Date(subscription.trial_end * 1000).toISOString()
              : null,
          })
          .eq('id', org.id)

        await inngest.send({
          name: 'billing/subscription-updated',
          data: {
            org_id:                 org.id,
            stripe_subscription_id: subscription.id,
            plan,
            plan_status:            planStatus,
          },
        })

        await logAuditEvent({
          orgId:    org.id,
          action:   'billing.subscription.updated',
          metadata: { plan, planStatus, subscriptionId: subscription.id },
        })
      }
      break
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object
      const customerId   = subscription.customer as string

      // RepuGuard subscription deleted
      if (subscription.metadata?.feature === 'repuguard') {
        const orgId = subscription.metadata?.org_id
        if (orgId) {
          await supabase
            .from('organizations')
            .update({ repuguard_status: 'cancelled' })
            .eq('id', orgId)
        }
        break
      }

      const { data: org } = await supabase
        .from('organizations')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .single()

      if (org) {
        await supabase
          .from('organizations')
          .update({ plan_status: 'cancelled' })
          .eq('id', org.id)

        await logAuditEvent({
          orgId:    org.id,
          action:   'billing.subscription.cancelled',
          metadata: { subscriptionId: subscription.id },
        })
      }
      break
    }

    default:
      // Unhandled event type — ignore
      break
  }

  return NextResponse.json({ received: true })
}
