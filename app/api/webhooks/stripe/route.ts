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
      const invoiceId  = session.metadata?.invoice_id
      const orgId      = session.metadata?.org_id
      const customerId = typeof session.customer === 'string' ? session.customer : null

      // ── Work order invoice payment path ──────────────────────────────────
      if (invoiceId && orgId) {
        // Idempotent update — safe to run twice
        const { data: inv } = await supabase
          .from('work_order_invoices')
          .update({
            status:                   'paid',
            stripe_payment_intent_id: typeof session.payment_intent === 'string'
              ? session.payment_intent
              : null,
            paid_at: new Date().toISOString(),
          })
          .eq('id', invoiceId)
          .eq('org_id', orgId)
          .eq('status', 'pending_payment')  // only update if still pending (idempotent)
          .select('id, work_order_id, vendor_id, property_id, total')
          .single()

        if (inv) {
          // Post expense to owner_transactions
          // source_reference_id dedup prevents double-posting on retry
          await supabase.from('owner_transactions').upsert(
            {
              org_id:               orgId,
              property_id:          inv.property_id,
              work_order_id:        inv.work_order_id,
              source:               'wo_completion',
              source_reference_id:  inv.work_order_id,
              transaction_type:     'expense',
              category:             'maintenance',
              amount:               inv.total,
              description:          `Work order invoice paid`,
              transaction_date:     new Date().toISOString().split('T')[0],
              visible_to_owner:     false,
            },
            { onConflict: 'source_reference_id,source', ignoreDuplicates: true }
          )

          // Update work order actual_cost
          await supabase
            .from('work_orders')
            .update({ actual_cost: inv.total })
            .eq('id', inv.work_order_id)
            .is('actual_cost', null)  // don't overwrite if PM already logged it

          // Fire audit event via Inngest (non-blocking)
          await inngest.send({
            name: 'work-order/invoice-paid',
            data: {
              work_order_id: inv.work_order_id,
              invoice_id:    inv.id,
              org_id:        orgId,
              property_id:   inv.property_id,
              amount_paid:   inv.total,
            },
          })

          await logAuditEvent({
            orgId,
            action:     'work_order.invoice.paid',
            targetType: 'work_order_invoice',
            targetId:   inv.id,
            metadata:   { amount: inv.total },
            // No Stripe session ID or payment intent ID — financial PII rule
          })
        }

        break
      }

      // ── Guidebook sponsor checkout path ───────────────────────────────────
      if (session.metadata?.feature === 'guidebook_sponsor') {
        await inngest.send({
          name: 'guidebook/sponsor.checkout.completed',
          data: {
            checkoutSessionId: session.id,
            sponsorId:         session.metadata.guidebook_sponsor_id!,
            orgId:             session.metadata.org_id!,
            subscriptionId:    session.subscription as string,
            customerId:        session.customer as string,
          },
        })
        break
      }

      // ── Subscription / billing path (existing) ───────────────────────────
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
      const planKey      = getPlanByPriceId(priceId) ?? 'starter'
      const plan         = planKey as PlanKey

      const planStatus = subscription.status === 'active'   ? 'active'
                       : subscription.status === 'trialing' ? 'trialing'
                       : subscription.status === 'past_due' ? 'past_due'
                       : 'cancelled'

      // Find the org by Stripe customer ID
      const { data: org } = await supabase
        .from('organizations')
        .select('id, name')
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

        // ── Trial lifecycle start (subscription.created while trialing) ───
        if (event.type === 'customer.subscription.created' && planStatus === 'trialing' && subscription.trial_end) {
          const { data: member } = await supabase
            .from('organization_members')
            .select('user_id')
            .eq('org_id', org.id)
            .eq('role', 'admin')
            .single()

          if (member?.user_id) {
            const { data: { user: adminUser } } = await supabase.auth.admin.getUserById(member.user_id)
            if (adminUser?.email) {
              const fullName = adminUser.user_metadata?.full_name as string | undefined

              await inngest.send({
                name: 'billing/trial-lifecycle-start',
                data: {
                  org_id:        org.id,
                  user_email:    adminUser.email,
                  first_name:    fullName?.split(' ')[0] ?? 'there',
                  org_name:      (org as { id: string; name?: string | null }).name ?? '',
                  trial_ends_at: new Date(subscription.trial_end * 1000).toISOString(),
                },
              })
            }
          }
        }

        // ── First payment confirmed (trialing → active transition) ────────
        if (event.type === 'customer.subscription.updated') {
          const previousAttributes = event.data.previous_attributes as Partial<{ status: string }> | undefined
          const previousStatus = previousAttributes?.status
          if (previousStatus === 'trialing' && planStatus === 'active') {
            const { data: member } = await supabase
              .from('organization_members')
              .select('user_id')
              .eq('org_id', org.id)
              .eq('role', 'admin')
              .single()

            if (member?.user_id) {
              const { data: { user: adminUser } } = await supabase.auth.admin.getUserById(member.user_id)
              if (adminUser?.email) {
                const fullName = adminUser.user_metadata?.full_name as string | undefined

                await inngest.send({
                  name: 'billing/first-payment-confirmed',
                  data: {
                    org_id:     org.id,
                    user_email: adminUser.email,
                    first_name: fullName?.split(' ')[0] ?? 'there',
                    org_name:   (org as { id: string; name?: string | null }).name ?? '',
                  },
                })
              }
            }
          }
        }
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

      // Guidebook sponsor subscription cancelled
      if (subscription.metadata?.feature === 'guidebook_sponsor') {
        const orgId     = subscription.metadata?.org_id
        const sponsorId = subscription.metadata?.guidebook_sponsor_id
        if (orgId && sponsorId) {
          await inngest.send({
            name: 'guidebook/sponsor.subscription.cancelled',
            data: { subscriptionId: subscription.id, orgId, sponsorId },
          })
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

    case 'invoice.payment_failed': {
      const invoice = event.data.object
      const subId   = invoice.subscription as string | null
      if (!subId) break

      const subscription = await stripe.subscriptions.retrieve(subId)
      if (subscription.metadata?.feature === 'guidebook_sponsor') {
        const orgId     = subscription.metadata.org_id
        const sponsorId = subscription.metadata.guidebook_sponsor_id
        if (orgId && sponsorId) {
          await inngest.send({
            name: 'guidebook/sponsor.payment.failed',
            data: { subscriptionId: subscription.id, orgId, sponsorId },
          })
        }
      }
      break
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object
      const subId   = invoice.subscription as string | null
      if (!subId) break

      const subscription = await stripe.subscriptions.retrieve(subId)
      if (subscription.metadata?.feature === 'guidebook_sponsor') {
        const orgId     = subscription.metadata.org_id
        const sponsorId = subscription.metadata.guidebook_sponsor_id
        if (orgId && sponsorId) {
          await inngest.send({
            name: 'guidebook/sponsor.payment.recovered',
            data: { subscriptionId: subscription.id, orgId, sponsorId },
          })
        }
      }
      break
    }

    default:
      // Unhandled event type — ignore
      break
  }

  return NextResponse.json({ received: true })
}
