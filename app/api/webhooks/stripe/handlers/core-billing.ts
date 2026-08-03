import type Stripe from 'stripe'
import { inngest } from '@/lib/inngest/client'
import { PLANS, getPlanByPriceId, type PlanKey } from '@/lib/stripe/client'
import { logAuditEvent } from '@/lib/audit'
import { getPmMembers } from '@/lib/inngest/helpers'
import { tryUnwrap } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
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
  // record, and a lookup failure must not block the billing email — so the
  // error is destructured and deliberately only logged. (Binding it also keeps
  // this out of the unhandled-result guardrail, whose Supabase heuristic peeks
  // ahead for a nearby `.from(` and cannot tell this Admin API call apart from
  // a PostgREST query.)
  const { data, error: userErr } = await supabase.auth.admin.getUserById(primaryPm.userId)
  if (userErr) {
    console.error('[stripe] admin.getUserById failed while resolving billing email name:', userErr.message)
  }
  const fullName = data?.user?.user_metadata?.full_name as string | undefined

  await send(primaryPm.email, fullName?.split(' ')[0] ?? 'there', primaryPm.userId)
}

interface ResolvedOrg { id: string; name: string | null }

/** One org lookup, throwing on a read error instead of reporting "not found". */
async function findOrg(
  supabase: StripeSupabaseClient,
  column:   'id' | 'stripe_customer_id',
  value:    string,
  site:     string,
): Promise<ResolvedOrg | null> {
  const res = await supabase
    .from('organizations')
    .select('id, name')
    .eq(column, value)
    .maybeSingle()

  // A failed READ must never collapse into "no org" — that is the same silent
  // failure this whole fix removes, and it would drop a paid customer's
  // entitlement on a transient DB blip while answering Stripe 200. Throwing
  // releases the webhook's dedup claim, so Stripe retries.
  const out = tryUnwrap<ResolvedOrg>(res, { site })
  if (!out.ok) throw new Error(`[stripe] org lookup (${column}) failed: ${site}`)
  return out.data ?? null
}

/**
 * Resolve the org behind a core-billing subscription.
 *
 * Metadata FIRST, customer id second. The customer-id link is written by
 * checkout.session.completed, so for a first-time subscriber it does not exist
 * yet when customer.subscription.created arrives — and Stripe does not
 * guarantee the order of those two events. Resolving only by customer id
 * therefore found nothing and returned silently: no plan, no plan_status, no
 * max_properties, no trial_ends_at, no trial-start email, and a 200 back to
 * Stripe so it never retried. The customer had paid and had no entitlement
 * until some later subscription.updated happened to fire.
 *
 * createCheckoutSession now stamps org_id onto subscription_data.metadata,
 * which removes the ordering dependency entirely for new checkouts.
 *
 * Returns null ONLY when this is not a core-billing subscription at all.
 */
async function resolveSubscriptionOrg(
  supabase:     StripeSupabaseClient,
  subscription: Stripe.Subscription,
  customerId:   string,
  priceId:      string,
): Promise<ResolvedOrg | null> {
  const metadataOrgId = subscription.metadata?.org_id ?? null

  let org = metadataOrgId
    ? await findOrg(supabase, 'id', metadataOrgId, 'webhook.stripe.core-billing.org-by-metadata')
    : null

  // Subscriptions created before subscription_data.metadata shipped, and
  // anything created outside the checkout flow (e.g. from the Stripe
  // dashboard), still resolve this way.
  org ??= await findOrg(supabase, 'stripe_customer_id', customerId, 'webhook.stripe.core-billing.org-by-customer')

  if (org) {
    // Backfill the customer link when metadata got us here first. Without it,
    // every later customer-id-only lookup for this org (invoice events, the
    // billing portal) would still miss.
    if (metadataOrgId && customerId) {
      const { error: backfillError } = await supabase
        .from('organizations')
        .update({ stripe_customer_id: customerId })
        .eq('id', org.id)
        .is('stripe_customer_id', null)

      // Not fatal — the entitlement write below is what the customer is
      // waiting on, and checkout.session.completed will set this column too.
      // But it must not vanish: if this silently fails, every later
      // customer-id-only lookup for this org keeps missing.
      if (backfillError) {
        console.error(
          `[stripe] stripe_customer_id backfill failed for org ${org.id}:`,
          backfillError.message,
        )
        reportError(backfillError, {
          site:  'webhook.stripe.core-billing.customer-backfill',
          orgId: org.id,
        })
      }
    }
    return org
  }

  // Not every subscription on this account is core billing — guidebook sponsor
  // subscriptions land here too, and their customer is a sponsor, not an org.
  // Those legitimately have no org and must NOT retry forever. The price id is
  // what tells the two apart: getPlanByPriceId only recognises our own plans.
  if (!getPlanByPriceId(priceId)) return null

  // It IS one of our plans, so an org must exist and we simply cannot see it
  // yet. Throw so Stripe retries with backoff and picks up the link written by
  // checkout.session.completed. Returning here is what left a paid customer
  // silently entitlement-less.
  throw new Error(
    `[stripe] core subscription ${subscription.id} (price ${priceId}) has no resolvable org — ` +
    `customer ${customerId} is not linked to an organization yet. Retrying.`
  )
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

  const org = await resolveSubscriptionOrg(supabase, subscription, customerId, priceId)
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

  const orgName = org.name ?? ''

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
