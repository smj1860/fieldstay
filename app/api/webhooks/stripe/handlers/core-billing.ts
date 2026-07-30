import type Stripe from 'stripe'
import { inngest } from '@/lib/inngest/client'
import { PLANS, getPlanByPriceId, type PlanKey } from '@/lib/stripe/client'
import { logAuditEvent } from '@/lib/audit'
import type { StripeSupabaseClient } from './types'

/** Core billing checkout completed — links the Stripe customer id to the org. */
export async function handleCheckoutSessionBilling(
  supabase: StripeSupabaseClient,
  orgId: string,
  customerId: string,
): Promise<void> {
  await supabase
    .from('organizations')
    .update({ stripe_customer_id: customerId })
    .eq('id', orgId)
    .is('stripe_customer_id', null)
}

async function notifyOrgAdmin(
  supabase: StripeSupabaseClient,
  orgId: string,
  send: (adminEmail: string, firstName: string) => Promise<void>,
): Promise<void> {
  const { data: member } = await supabase
    .from('organization_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('role', 'admin')
    .single()
  if (!member?.user_id) return

  const { data: { user: adminUser } } = await supabase.auth.admin.getUserById(member.user_id)
  if (!adminUser?.email) return

  const fullName = adminUser.user_metadata?.full_name as string | undefined
  await send(adminUser.email, fullName?.split(' ')[0] ?? 'there')
}

/** Core billing subscription created or updated (plan/status sync + trial-lifecycle emails). */
export async function handleCoreSubscriptionUpdate(
  supabase: StripeSupabaseClient,
  subscription: Stripe.Subscription,
  eventType: 'customer.subscription.created' | 'customer.subscription.updated',
  previousStatus: string | undefined,
): Promise<void> {
  const customerId = subscription.customer as string
  const priceId     = subscription.items.data[0]?.price.id ?? ''
  const planKey     = getPlanByPriceId(priceId) ?? 'starter'
  const plan        = planKey as PlanKey

  const planStatus = subscription.status === 'active'   ? 'active'
                    : subscription.status === 'trialing' ? 'trialing'
                    : subscription.status === 'past_due' ? 'past_due'
                    : 'cancelled'

  // Find the org by Stripe customer ID — `plan` is read here, before the
  // update below overwrites it, so a genuine tier change (starter -> pro)
  // can be told apart from the initial trial signup (where the org's
  // just-created default plan happens not to match whatever tier they
  // signed up for, which is not a "plan changed" event from the PM's
  // perspective — see the eventType gate below).
  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, plan')
    .eq('stripe_customer_id', customerId)
    .single()
  if (!org) return

  const previousPlan = (org as { plan?: string }).plan as PlanKey | undefined

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

  // previous_plan is only meaningful on an update to an existing
  // subscription — never on creation, where the org's pre-signup default
  // plan isn't a real "previous" tier the PM ever knowingly held.
  const genuinePreviousPlan =
    eventType === 'customer.subscription.updated' ? (previousPlan ?? null) : null

  await inngest.send({
    name: 'billing/subscription-updated',
    data: {
      org_id:                 org.id,
      stripe_subscription_id: subscription.id,
      plan,
      plan_status:            planStatus,
      previous_plan:          genuinePreviousPlan,
    },
  })

  await logAuditEvent({
    orgId:    org.id,
    action:   'billing.subscription.updated',
    metadata: { plan, planStatus, subscriptionId: subscription.id },
  })

  const orgName = (org as { id: string; name?: string | null }).name ?? ''

  // ── Trial lifecycle start (subscription.created while trialing) ───
  if (eventType === 'customer.subscription.created' && planStatus === 'trialing' && subscription.trial_end) {
    const trialEndsAt = subscription.trial_end
    await notifyOrgAdmin(supabase, org.id, async (userEmail, firstName) => {
      await inngest.send({
        name: 'billing/trial-lifecycle-start',
        data: {
          org_id:        org.id,
          user_email:    userEmail,
          first_name:    firstName,
          org_name:      orgName,
          trial_ends_at: new Date(trialEndsAt * 1000).toISOString(),
        },
      })
    })
  }

  // ── First payment confirmed (trialing → active transition) ────────
  if (eventType === 'customer.subscription.updated' && previousStatus === 'trialing' && planStatus === 'active') {
    await notifyOrgAdmin(supabase, org.id, async (userEmail, firstName) => {
      await inngest.send({
        name: 'billing/first-payment-confirmed',
        data: {
          org_id:     org.id,
          user_email: userEmail,
          first_name: firstName,
          org_name:   orgName,
        },
      })
    })
  }
}

/** Core billing subscription cancelled. */
export async function handleCoreSubscriptionCancelled(
  supabase: StripeSupabaseClient,
  subscription: Stripe.Subscription,
  customerId: string,
): Promise<void> {
  const { data: org } = await supabase
    .from('organizations')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()
  if (!org) return

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
