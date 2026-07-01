import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'

export const guidebookDailyMonitor = inngest.createFunction(
  {
    id:   'guidebook-daily-monitor',
    name: 'Guidebook: Daily Billing Dispatcher',
  },
  { cron: '0 13 * * *' }, // 8 AM CT (UTC-5)
  async ({ step, logger }) => {
    const now48hrs = new Date(Date.now() + 48 * 60 * 60 * 1000)

    // Fetch all active guidebook orgs in one query
    const activeOrgs = await step.run('fetch-active-guidebook-orgs', async () => {
      const supabase = createServiceClient()
      const { data, error } = await supabase
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

      if (error) throw new Error(`Failed to fetch active guidebooks: ${error.message}`)
      return data ?? []
    })

    logger.info(`Evaluating ${activeOrgs.length} active guidebook orgs for billing credits`)

    type CreditEvent = {
      name: 'guidebook/billing.credit.evaluate'
      data: { orgId: string; stripeCustomerId: string; currentPeriodEnd: number }
    }

    type GraceExpiredEvent = {
      name: 'guidebook/grace.period.expired'
      data: { orgId: string }
    }

    const events: (CreditEvent | GraceExpiredEvent)[] = []

    for (const row of activeOrgs) {
      const org = Array.isArray(row.organizations)
        ? row.organizations[0]
        : row.organizations

      if (!org?.stripe_subscription_id || !org.stripe_customer_id) continue

      // Check renewal window — only dispatch if billing within 48 hours
      // Store currentPeriodEnd here so the handler has it for idempotency key
      // without needing another Stripe API call
      const creditEvent = await step.run(`check-renewal-${row.org_id}`, async () => {
        const subscription = await stripe.subscriptions.retrieve(
          org.stripe_subscription_id!
        )
        const periodEnd = new Date(subscription.current_period_end * 1000)
        if (periodEnd > now48hrs) return null

        // Only dispatch if org has ≥ 5 sponsors (credit threshold)
        const activeSponsorCount = await getActiveSponsorCount(row.org_id)
        if (activeSponsorCount < 5) return null

        return {
          name: 'guidebook/billing.credit.evaluate' as const,
          data: {
            orgId:            row.org_id,
            stripeCustomerId: org.stripe_customer_id!,
            currentPeriodEnd: subscription.current_period_end,
          },
        }
      })

      if (creditEvent) events.push(creditEvent)
    }

    // Grace period expiry check — runs daily alongside billing evaluation
    for (const row of activeOrgs) {
      if (!row.grace_period_ends_at) continue
      const graceEnd = new Date(row.grace_period_ends_at)
      if (graceEnd <= new Date()) {
        events.push({
          name: 'guidebook/grace.period.expired',
          data: { orgId: row.org_id },
        })
      }
    }

    if (events.length > 0) {
      await inngest.send(events)
    }

    logger.info(`Dispatched ${events.length} guidebook event(s)`)

    // Trial expiry check — lock any guidebook whose trial ended overnight
    // and still has fewer than 3 active sponsors.
    let trialLockedCount = 0
    for (const row of activeOrgs) {
      if (!row.trial_ends_at) continue
      if (new Date(row.trial_ends_at) > new Date()) continue // still in trial

      await step.run(`check-trial-expired-${row.org_id}`, async () => {
        const supabase = createServiceClient()
        const activeSponsorCount = await getActiveSponsorCount(row.org_id)
        if (activeSponsorCount >= 3) return { skipped: true }

        await supabase
          .from('guidebook_configurations')
          .update({
            is_active:  false,
            updated_at: new Date().toISOString(),
          })
          .eq('org_id', row.org_id)

        return { locked: true, activeSponsorCount }
      })

      trialLockedCount++
    }

    if (trialLockedCount > 0) {
      logger.info(`Checked ${trialLockedCount} trial-expired guidebook org(s)`)
    }

    return { evaluated: activeOrgs.length, dispatched: events.length }
  }
)
