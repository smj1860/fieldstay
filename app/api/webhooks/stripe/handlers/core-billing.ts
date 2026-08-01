import type Stripe from 'stripe'
import { inngest } from '@/lib/inngest/client'
import { PLANS, getPlanByPriceId, type PlanKey } from '@/lib/stripe/client'
import { logAuditEvent } from '@/lib/audit'
import { getPmMembers } from '@/lib/inngest/helpers'
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

/**
 * Picks the human who receives a billing-lifecycle email for an org.
 *
 * Goes through getPmMembers() (lib/inngest/helpers.ts, the single source of
 * truth for "who is the PM") rather than querying organization_members here.
 * The inline query this replaced was `.eq('role','admin').single()`, which was
 * wrong twice over: it EXCLUDED owners — the role most solo PMs actually hold,
 * and the one CLAUDE.md records as always passing a role check — so a
 * single-owner org got no trial-start or first-payment email at all; and
 * `.single()` THROWS on more than one row, so an org with two admins failed
 * the whole webhook handler. getPmMembers defaults to ['owner','admin'],
 * applies the invite_accepted_at filter, and orders owner → admin → manager,
 * so `limit: 1` is a deterministic "the owner if there is one, else the first
 * admin" rather than whatever Postgres felt like returning.
 *
 * StripeSupabaseClient is the service-role client, which is what getPmMembers
 * requires — it resolves emails through the Admin API (auth.admin), so an
 * RLS-scoped client would not work here.
 */
async function notifyOrgAdmin(
  supabase: StripeSupabaseClient,
  orgId: string,
  // userId is passed through so a downstream commercial email can resolve the
  // recipient's CAN-SPAM opt-out state and unsubscribe token — the email alone
  // cannot, since profiles is keyed by auth user id and holds no email column.
  send: (adminEmail: string, firstName: string, userId: string) => Promise<void>,
): Promise<void> {
  const [primaryPm] = await getPmMembers(supabase, orgId, { limit: 1 })
  if (!primaryPm) return

  // getPmMembers resolves the email; the display name still needs the user
  // record, and a lookup failure must not block the billing email.
  const { data } = await supabase.auth.admin.getUserById(primaryPm.userId)
  const fullName = data?.user?.user_metadata?.full_name as string | undefined

  await send(primaryPm.email, fullName?.split(' ')[0] ?? 'there', primaryPm.userId)
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

  // Find the org by Stripe customer ID
  const { data: org } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('stripe_customer_id', customerId)
    .single()
  if (!org) return

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

  const orgName = (org as { id: string; name?: string | null }).name ?? ''

  // ── Trial lifecycle start (subscription.created while trialing) ───
  if (eventType === 'customer.subscription.created' && planStatus === 'trialing' && subscription.trial_end) {
    const trialEndsAt = subscription.trial_end
    await notifyOrgAdmin(supabase, org.id, async (userEmail, firstName, userId) => {
      await inngest.send({
        name: 'billing/trial-lifecycle-start',
        data: {
          org_id:        org.id,
          user_id:       userId,
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
