import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { stripe }              from '@/lib/stripe/client'
import { fetchAllRows }        from '@/lib/inngest/paginate'
import { createPmNotification } from '@/lib/inngest/helpers'
import { logAuditEvent }       from '@/lib/audit'
import { reportError }         from '@/lib/observability/report-error'

// ============================================================================
// Keeps a self-serve org's Stripe subscription QUANTITY in sync with its
// actual active property count — the mechanism that makes graduated pricing
// (lib/stripe/brackets.ts) frictionless: a PM can add property 5 the moment
// they need to, without checking out again, and the bill catches up on its
// own with the proration behavior the 2026-08-29 pricing rebuild locked in:
//
//   MONTHLY: any change (up or down) is applied with `proration_behavior:
//   'none'` — no charge or credit now, it just takes effect on the next
//   natural invoice. Simple, because monthly renewals are frequent enough
//   that "wait for it" is never a long wait.
//
//   ANNUAL: a DECREASE is applied immediately with `proration_behavior:
//   'none'` too (same reasoning — no rush to credit something that only
//   matters at next renewal, but the stored quantity must be corrected now so
//   renewal bills the right number). An INCREASE is held rather than applied
//   per property: Stripe's subscription item `quantity` field IS the "held"
//   baseline (no separate DB column needed — comparing today's live count
//   against Stripe's current quantity gives exactly the ADDITIONS pending
//   since the last flush or renewal). Once that pending delta reaches 5
//   properties, the ENTIRE delta is flushed in one `create_prorations` call —
//   the 5th addition and all 4 before it are prorated together, starting
//   TODAY (Stripe's default proration_date, i.e. no backdating to when each
//   property was actually added).
//
// This file is the dispatcher half (finds candidate orgs, fans out one event
// per org) — see reconcilePropertyCountForOrg below for the per-org work.
// Same two-function shape as daily-wrapup.ts, for the same reason: a serial
// for-loop calling Stripe once per org inside one invocation scales step
// count (and this cron's own runtime) with the platform's tenant count
// instead of with one tenant.
// ============================================================================

/** Properties added since the last flush/renewal before an annual sub gets the full retroactive proration. */
export const ANNUAL_PRORATION_ADDITION_THRESHOLD = 5

export const billingPropertyReconciliation = inngest.createFunction(
  { id: 'cron-billing-property-reconciliation', name: 'Cron: Billing Property-Count Reconciliation', retries: 2 },
  { cron: '0 10 * * *' },  // 5am CT (UTC-5) — well before the daily wrap-up
  async ({ step, logger }) => {
    const orgIds = await step.run('find-candidate-orgs', async () => {
      const supabase = createServiceClient({ system: 'inngest:billing-property-reconciliation' })

      const orgs = await fetchAllRows<{ id: string }>(
        (from, to) => supabase
          .from('organizations')
          .select('id')
          // Only self-serve orgs on the graduated platform price have a
          // Stripe-tracked QUANTITY to reconcile at all — Enterprise orgs are
          // manually contracted and this cron has no business touching them.
          .eq('plan', 'platform')
          .in('plan_status', ['active', 'trialing'])
          .not('stripe_subscription_id', 'is', null)
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'organizations(billing-property-reconciliation)' }
      )

      return orgs.map((o) => o.id)
    })

    if (orgIds.length) {
      await step.sendEvent(
        'fan-out-property-reconciliation',
        orgIds.map((orgId) => ({
          name: 'billing/reconcile-property-count.requested' as const,
          data: { org_id: orgId },
        }))
      )
    }

    logger.info(`Billing property-count reconciliation: dispatched ${orgIds.length} org(s)`)
    return { dispatched: orgIds.length }
  }
)

export const reconcilePropertyCountForOrg = inngest.createFunction(
  {
    id:   'billing-reconcile-property-count-org',
    name: 'Billing: Reconcile Property Count — per org',
    retries: 3,
    concurrency: { limit: 10 },
  },
  { event: 'billing/reconcile-property-count.requested' },
  async ({ event, step }) => {
    const orgId = event.data.org_id

    await step.run('reconcile', async () => {
      const supabase = createServiceClient({ system: 'inngest:billing-property-reconciliation' })

      const orgRes = await supabase
        .from('organizations')
        .select('stripe_subscription_id')
        .eq('id', orgId)
        .maybeSingle()

      // Re-read rather than trust the dispatcher's snapshot — the org may have
      // cancelled or lost its subscription id in the time between the two
      // steps (they can run on different days if this run was delayed).
      if (orgRes.error) {
        reportError(orgRes.error, { site: 'inngest.billing-property-reconciliation.org-lookup', orgId })
        return
      }
      const subscriptionId = orgRes.data?.stripe_subscription_id
      if (!subscriptionId) return

      // head+count — ships no rows, so max_rows cannot truncate it. Matches
      // createCheckoutSession's own count exactly (is_active: true), so
      // checkout and reconciliation never disagree about what a property is.
      const countRes = await supabase
        .from('properties')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('is_active', true)

      if (countRes.error) {
        reportError(countRes.error, { site: 'inngest.billing-property-reconciliation.property-count', orgId })
        return
      }
      const currentCount = countRes.count ?? 0
      // Zero active properties is a real state (e.g. mid-offboarding) but not
      // one this cron should ever bill — leave the subscription exactly as
      // Stripe has it rather than zeroing out a quantity Stripe may reject.
      if (currentCount < 1) return

      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      const item = subscription.items.data[0]
      if (!item) {
        reportError(new Error('Platform subscription has no line item to reconcile'), {
          site: 'inngest.billing-property-reconciliation.no-item', orgId,
          extra: { subscription_id: subscriptionId },
        })
        return
      }

      const billedQuantity = item.quantity ?? 0
      if (currentCount === billedQuantity) return  // already in sync

      const interval = subscription.items.data[0]?.price?.recurring?.interval ?? 'month'

      if (interval !== 'year') {
        // Monthly: any direction, deferred to the next natural invoice.
        await stripe.subscriptions.update(subscriptionId, {
          items:              [{ id: item.id, quantity: currentCount }],
          proration_behavior: 'none',
        })
        return
      }

      // Annual, and a DECREASE: apply now (no charge implied — 'none' just
      // means "credit nothing today"), so the quantity is correct by the time
      // the next renewal bills it.
      if (currentCount < billedQuantity) {
        await stripe.subscriptions.update(subscriptionId, {
          items:              [{ id: item.id, quantity: currentCount }],
          proration_behavior: 'none',
        })
        return
      }

      // Annual, and an INCREASE: Stripe's own recorded quantity IS the held
      // baseline, so this delta is exactly how many properties have been
      // added since the last flush or renewal — nothing else needs storing.
      const pendingAdditions = currentCount - billedQuantity
      if (pendingAdditions < ANNUAL_PRORATION_ADDITION_THRESHOLD) return  // keep holding

      // Threshold reached: flush the WHOLE pending delta in one shot, prorated
      // from today forward (Stripe's default proration_date — no backdating
      // to when property 2, or property 5, was actually added).
      await stripe.subscriptions.update(subscriptionId, {
        items:              [{ id: item.id, quantity: currentCount }],
        proration_behavior: 'create_prorations',
      })

      await logAuditEvent({
        orgId,
        action:   'billing.subscription.quantity_prorated',
        metadata: { previousQuantity: billedQuantity, newQuantity: currentCount, pendingAdditions },
      })

      await createPmNotification(supabase, {
        orgId,
        type:     'billing_quantity_updated',
        title:    `Your subscription now reflects ${currentCount} properties`,
        subtitle:
          `You added ${pendingAdditions} properties since your last renewal, so this year's remaining ` +
          `balance was prorated for all of them today.`,
        href:      '/settings?tab=billing',
        severity:  'blue',
        // State-keyed, not day-keyed: this is a one-time flush for this
        // specific quantity jump, and a retry of this same step must not
        // insert a second notification for it.
        dedupeKey: `billing-quantity-flush-${orgId}-${billedQuantity}-${currentCount}`,
      })
    })
  }
)
