import { inngest } from '@/lib/inngest/client'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { throwIfAnyQueryFailed, unwrap } from '@/lib/supabase/unwrap'

/** Nullability matches the live schema: org_id is NOT NULL on
 *  guidebook_configurations, both date columns are nullable, and the
 *  to-one `organizations` embed can arrive as an array from PostgREST. */
interface GuidebookOrgRow {
  org_id:               string
  grace_period_ends_at: string | null
  trial_ends_at:        string | null
  organizations:
    | { stripe_customer_id: string | null; stripe_subscription_id: string | null }
    | { stripe_customer_id: string | null; stripe_subscription_id: string | null }[]
    | null
}

/**
 * DISPATCHER ONLY.
 *
 * Named "Dispatcher" all along, but it wasn't one: it ran a Stripe
 * subscription lookup as its own step for EVERY active guidebook org, then a
 * second serial `for (const row of activeOrgs) { await step.run(...) }` for
 * trial lock-outs — both inside a single invocation, both scaling with the
 * platform's tenant count. Promise.all made the Stripe steps concurrent but
 * did nothing about how many of them there were.
 *
 * Now: grace-period expiry (a pure date comparison, no query) stays batched
 * here, and everything needing a per-org Stripe call or sponsor count fans out
 * to guidebookDailyMonitorOrg under its own concurrency cap.
 */
export const guidebookDailyMonitor = inngest.createFunction(
  {
    id:   'guidebook-daily-monitor',
    name: 'Guidebook: Daily Billing Dispatcher',
  },
  { cron: '0 13 * * *' }, // 8 AM CT (UTC-5)
  async ({ step, logger }) => {
    // Fetch all active guidebook orgs in one query
    const activeOrgs = await step.run('fetch-active-guidebook-orgs', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-daily-monitor' })
      // Paginated: one row per ORG with an active guidebook, so the result
      // set is the platform's tenant count. This list drives three separate
      // per-org decisions below — sponsor-credit dispatch, grace-period
      // expiry and trial lock-out — so a max_rows truncation means the orgs
      // past row 1000 are never billed a credit they earned, never have an
      // expired grace period acted on, and keep an expired trial live
      // indefinitely. All three fail in the customer's favour or against it
      // silently, with the cron reporting a healthy run either way.
      return await fetchAllRows<GuidebookOrgRow>(
        (from, to) => supabase
          .from('guidebook_configurations')
          .select(`
            org_id,
            grace_period_ends_at,
            trial_ends_at,
            organizations (
              stripe_customer_id,
              stripe_subscription_id
            )
          `)
          .eq('is_active', true)
          .order('org_id')
          .range(from, to),
        { label: 'guidebook-daily-monitor.active-orgs' },
      )
    })

    // Grace-period expiry is a pure date comparison over rows already in hand
    // — no query, no Stripe call — so it stays batched in the dispatcher.
    const graceExpired = activeOrgs.filter((row) =>
      row.grace_period_ends_at !== null && new Date(row.grace_period_ends_at) <= new Date()
    )

    if (graceExpired.length) {
      await step.sendEvent(
        'fan-out-grace-expired',
        graceExpired.map((row) => ({
          name: 'guidebook/grace.period.expired' as const,
          data: { orgId: row.org_id },
        }))
      )
    }

    // Everything else needs a per-org Stripe call or a per-org sponsor count,
    // so it fans out. Only orgs that could actually produce work are
    // dispatched: an org with no Stripe subscription AND no expired trial has
    // nothing for the handler to do, and used to cost a step to establish that.
    const needsEvaluation = activeOrgs.filter((row) => {
      const org = unwrapJoin(row.organizations)
      const billable    = Boolean(org?.stripe_subscription_id && org.stripe_customer_id)
      const trialLapsed = row.trial_ends_at !== null && new Date(row.trial_ends_at) <= new Date()
      return billable || trialLapsed
    })

    if (needsEvaluation.length) {
      await step.sendEvent(
        'fan-out-guidebook-daily-monitor',
        needsEvaluation.map((row) => ({
          name: 'org/guidebook_daily_monitor.requested' as const,
          data: { org_id: row.org_id },
        }))
      )
    }

    logger.info(
      `Guidebook daily monitor: ${activeOrgs.length} active org(s), ` +
      `${graceExpired.length} grace-expired, ${needsEvaluation.length} dispatched`
    )

    return {
      evaluated:  activeOrgs.length,
      dispatched: needsEvaluation.length + graceExpired.length,
    }
  }
)

/**
 * Per-org guidebook billing + trial evaluation. One invocation = one tenant.
 *
 * Both halves need this org's live state, so the row is re-read here rather
 * than carried on the event — a Stripe subscription id on an Inngest payload
 * is both stale-able and needless, since the handler has to touch the row
 * anyway.
 */
export const guidebookDailyMonitorOrg = inngest.createFunction(
  {
    id:          'guidebook-daily-monitor-org',
    name:        'Guidebook: Daily Billing — per org',
    retries:     2,
    concurrency: { limit: 10 },
  },
  { event: 'org/guidebook_daily_monitor.requested' },
  async ({ event, step, logger }) => {
    const orgId     = event.data.org_id
    const now48hrs  = new Date(Date.now() + 48 * 60 * 60 * 1000)

    const row = await step.run('load-guidebook-config', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-daily-monitor' })
      const res = await supabase
        .from('guidebook_configurations')
        .select(`
          org_id,
          trial_ends_at,
          is_active,
          organizations (
            stripe_customer_id,
            stripe_subscription_id
          )
        `)
        .eq('org_id', orgId)
        .maybeSingle()

      return unwrap(res, { site: 'inngest.guidebook-daily-monitor-org.config', orgId })
    }) as (GuidebookOrgRow & { is_active: boolean }) | null

    // Re-checked, not assumed: the dispatcher's snapshot can be minutes old,
    // and a guidebook locked in between must not then be billed a credit.
    if (!row?.is_active) {
      logger.info(`Org ${orgId}: guidebook no longer active — skipping`)
      return { org_id: orgId, skipped: true }
    }

    const org = unwrapJoin(row.organizations)

    // ── Billing credit ──────────────────────────────────────────────────────
    if (org?.stripe_subscription_id && org.stripe_customer_id) {
      const creditEvent = await step.run('check-renewal', async () => {
        const subscription = await stripe.subscriptions.retrieve(org.stripe_subscription_id!)
        const periodEnd = new Date(subscription.current_period_end * 1000)
        if (periodEnd > now48hrs) return null

        // Every sponsor now earns credit ($5 each), so the old ">= 5" gate
        // would suppress the credit it exists to deliver. Kept as ">= 1"
        // rather than removed: a zero-sponsor org would dispatch an event
        // whose handler immediately no-ops, which is a daily Inngest run per
        // org for nothing.
        const activeSponsorCount = await getActiveSponsorCount(orgId)
        if (activeSponsorCount < 1) return null

        // current_period_end rides along so the handler has the idempotency
        // key without a second Stripe call.
        return { stripeCustomerId: org.stripe_customer_id!, currentPeriodEnd: subscription.current_period_end }
      })

      if (creditEvent) {
        await step.sendEvent('send-credit-evaluate', {
          name: 'guidebook/billing.credit.evaluate' as const,
          data: { orgId, ...creditEvent },
        })
      }
    }

    // ── Trial expiry lock-out ───────────────────────────────────────────────
    const trialLapsed = row.trial_ends_at !== null && new Date(row.trial_ends_at) <= new Date()
    if (!trialLapsed) return { org_id: orgId, trial_locked: false }

    const locked = await step.run('check-trial-expired', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-daily-monitor' })
      const activeSponsorCount = await getActiveSponsorCount(orgId)
      if (activeSponsorCount >= 3) return false

      const { error } = await supabase
        .from('guidebook_configurations')
        .update({
          is_active:  false,
          updated_at: new Date().toISOString(),
        })
        .eq('org_id', orgId)

      throwIfAnyQueryFailed(
        { site: 'inngest.guidebook-daily-monitor.check-trial-expired', orgId },
        error
      )

      return true
    })

    return { org_id: orgId, trial_locked: locked }
  }
)
