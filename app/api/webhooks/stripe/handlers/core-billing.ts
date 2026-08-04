import type Stripe from 'stripe'
import { inngest } from '@/lib/inngest/client'
import { PLANS, getPlanByPriceId, type PlanKey } from '@/lib/stripe/client'
import { logAuditEvent } from '@/lib/audit'
import { getPmMembers } from '@/lib/inngest/helpers'
import { tryUnwrap } from '@/lib/supabase/unwrap'
import { nullableArg } from '@/lib/supabase/rpc-args'
import { reportError } from '@/lib/observability/report-error'
import type { OrgPlanStatus } from '@/types/database'
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

interface SubscriptionFields {
  subscriptionId: string
  plan:           PlanKey
  planStatus:     OrgPlanStatus
  trialEndsAt:    string | null
}

/**
 * Writes the org's entitlement and returns the plan it held beforehand.
 *
 * The RPC does the lookup, row lock, read-old, and write in ONE server-side
 * transaction (supabase/migrations/20260730140000_atomic_subscription_plan_update.sql).
 * PostgREST cannot express that shape — there is no RETURNING of a pre-update
 * column — so a plain read-then-write let two concurrent deliveries for the
 * same org both read the same stale previous_plan.
 */
async function applySubscriptionUpdate(
  supabase:   StripeSupabaseClient,
  org:        ResolvedOrg,
  customerId: string,
  fields:     SubscriptionFields,
): Promise<PlanKey | null> {
  const { data: rpcResult, error: updateError } = await supabase
    .rpc('update_organization_subscription_from_stripe', {
      p_customer_id:            customerId,
      p_stripe_subscription_id: fields.subscriptionId,
      p_plan:                   fields.plan,
      p_plan_status:            fields.planStatus,
      p_max_properties:         PLANS[fields.plan].maxProperties,
      // The parameter is a plain nullable timestamptz — a subscription with no
      // trial passes NULL — but pg_proc records no argument nullability, so
      // the generated Args type says `string`. See lib/supabase/rpc-args.ts.
      p_trial_ends_at:          nullableArg(fields.trialEndsAt),
    })
    .maybeSingle()

  if (updateError) {
    throw new Error(
      `update_organization_subscription_from_stripe failed for customer ${customerId}: ${updateError.message}`,
    )
  }

  // StripeSupabaseClient carries no <Database> generic (see the note in
  // types/database.ts), so .rpc() infers `{}` rather than the real shape —
  // cast to the RETURNS TABLE columns from the migration.
  const updated = rpcResult as { org_id: string; org_name: string | null; previous_plan: PlanKey } | null
  if (updated) return updated.previous_plan

  // The RPC keys on stripe_customer_id, which is normally in agreement with
  // the org we just resolved — resolveSubscriptionOrg backfills that column
  // when metadata got us here first. It disagrees for an org already carrying
  // a DIFFERENT customer id, where the backfill deliberately no-ops: the
  // metadata lookup found the org, the RPC's lookup does not, and returning
  // on that miss would re-open the silent entitlement drop the metadata
  // resolution exists to fix. Write it directly instead, scoped to the org we
  // did resolve.
  console.warn(
    `[stripe] subscription RPC found no org for customer ${customerId}; ` +
    `falling back to a direct update on org ${org.id}`,
  )
  const { error: fallbackError } = await supabase
    .from('organizations')
    .update({
      stripe_subscription_id: fields.subscriptionId,
      plan:            fields.plan,
      plan_status:     fields.planStatus,
      max_properties:  PLANS[fields.plan].maxProperties,
      trial_ends_at:   fields.trialEndsAt,
    })
    .eq('id', org.id)

  if (fallbackError) {
    throw new Error(`organizations update failed for org ${org.id}: ${fallbackError.message}`)
  }

  // Genuinely unknown on this path — the pre-update plan was never read under
  // a lock. Null is honest; a guess would mislabel the plan-change email.
  return null
}

/** Core billing subscription created or updated (plan/status sync + trial-lifecycle emails). */
export async function handleCoreSubscriptionUpdate(
  supabase: StripeSupabaseClient,
  subscription: Stripe.Subscription,
  eventType: 'customer.subscription.created' | 'customer.subscription.updated',
  previousStatus: string | undefined,
): Promise<void> {
  const customerId = subscription.customer as string
  // The plan-bearing item, not blindly items.data[0] — an add-on line could
  // sit in position 0 and mask the real plan price.
  const priceId    = subscription.items.data.find((i) => getPlanByPriceId(i.price.id))?.price.id
                     ?? subscription.items.data[0]?.price.id
                     ?? ''
  const planKey    = getPlanByPriceId(priceId)

  const planStatus = subscription.status === 'active'   ? 'active'
                    : subscription.status === 'trialing' ? 'trialing'
                    : subscription.status === 'past_due' ? 'past_due'
                    : 'cancelled'

  // Two independent fixes meet on this block and BOTH are load-bearing, so
  // neither side of the merge wins outright:
  //
  //  - Resolving the org must happen through subscription metadata first and
  //    the customer id second, because the customer-id link is written by
  //    checkout.session.completed and Stripe does not guarantee it arrives
  //    before subscription.created. Customer-id-only resolution left
  //    first-time subscribers paid and entitlement-less.
  //  - The update itself must hold a row lock, because two concurrent
  //    deliveries for the same org could both read the same stale
  //    previous_plan before either write committed.
  //
  // Resolve first — it also throws to force a Stripe retry when one of our
  // plans has no resolvable org yet, and backfills the customer link — then
  // do the locked update.
  const org = await resolveSubscriptionOrg(supabase, subscription, customerId, priceId)
  if (!org) return

  // An unrecognized price is NOT Starter.
  //
  // This used to be `getPlanByPriceId(priceId) ?? 'starter'`, which wrote
  // max_properties: 15 over any plan whose price we cannot map. PLANS.enterprise
  // has monthlyPriceId/annualPriceId of null (it is "contact for pricing"), so
  // getPlanByPriceId can NEVER return 'enterprise' — every enterprise org was
  // rewritten to Starter/15 on any subscription event. Promo prices,
  // grandfathered prices and dashboard-created subscriptions are the same case.
  //
  // Status still syncs, because past_due/cancelled must take effect regardless
  // of whether we can name the tier. Only the entitlement columns are left
  // alone rather than guessed downward.
  if (!planKey) {
    reportError(new Error('Stripe subscription carries an unmapped price id'), {
      site:  'webhook.stripe.core-billing.unmapped-price',
      orgId: org.id,
      extra: { subscription_id: subscription.id, price_id: priceId, plan_status: planStatus },
    })

    const { error: statusError } = await supabase
      .from('organizations')
      .update({ plan_status: planStatus })
      .eq('id', org.id)

    if (statusError) {
      throw new Error(`plan_status sync failed for org ${org.id}: ${statusError.message}`)
    }
    return
  }

  const plan = planKey

  const previousPlan = await applySubscriptionUpdate(supabase, org, customerId, {
    subscriptionId: subscription.id,
    plan,
    planStatus,
    trialEndsAt: subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : null,
  })

  // previous_plan is only meaningful on an update to an existing
  // subscription — never on creation, where the org's pre-signup default
  // plan isn't a real "previous" tier the PM ever knowingly held.
  const genuinePreviousPlan =
    eventType === 'customer.subscription.updated' ? previousPlan : null

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
): Promise<void> {
  const customerId = subscription.customer as string

  // Metadata first, customer id second — the same resolution order the
  // create/update path uses, and for the same reason. applySubscriptionUpdate
  // documents a live case where the customer-id backfill deliberately no-ops
  // (an org already carrying a DIFFERENT customer id); for such an org,
  // customer-id-only resolution found nothing and returned silently.
  //
  // findOrg throws on a read failure instead of collapsing it into "no org".
  // This used to be `const { data: org } = await …single()` with the error
  // discarded, so a transient DB failure produced org === null, the handler
  // returned, and the route answered Stripe 200 — no retry, plan_status left
  // 'active' forever, and a cancelled customer kept full entitlement with
  // nothing logged. findOrg exists in this very file precisely to stop that;
  // cancellation was the one handler that never got it, and it fails in the
  // more expensive direction.
  const metadataOrgId = subscription.metadata?.org_id ?? null
  const org =
    (metadataOrgId
      ? await findOrg(supabase, 'id', metadataOrgId, 'webhook.stripe.core-billing.cancel-by-metadata')
      : null)
    ?? await findOrg(supabase, 'stripe_customer_id', customerId, 'webhook.stripe.core-billing.cancel-by-customer')

  if (!org) {
    // Genuinely unresolvable rather than a read error (findOrg would have
    // thrown). Report instead of retrying forever.
    reportError(new Error('Core subscription cancelled for an unresolvable org'), {
      site:  'webhook.stripe.core-billing.cancel-unresolved',
      extra: { subscription_id: subscription.id, customer_id: customerId },
    })
    return
  }

  const { error: updateError } = await supabase
    .from('organizations')
    .update({ plan_status: 'cancelled' })
    .eq('id', org.id)

  // Throw so the claim releases and Stripe retries — a silently dropped
  // cancellation is an entitlement the customer has stopped paying for.
  if (updateError) {
    throw new Error(`plan_status cancel failed for org ${org.id}: ${updateError.message}`)
  }

  await logAuditEvent({
    orgId:    org.id,
    action:   'billing.subscription.cancelled',
    metadata: { subscriptionId: subscription.id },
  })
}
