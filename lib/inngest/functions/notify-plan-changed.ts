import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { PLANS, type PlanKey }  from '@/lib/stripe/client'

function planName(plan: string): string {
  return plan in PLANS ? PLANS[plan as PlanKey].name : plan
}

export const notifyPlanChanged = inngest.createFunction(
  { id: 'notify-plan-changed', name: 'Notify PM: Plan Changed', retries: 2 },
  { event: 'billing/subscription-updated' as const },
  async ({ event, step }) => {
    const { org_id, plan, previous_plan } = event.data

    // previous_plan is null on initial signup and on any subscription
    // update that didn't change the tier (a status-only change, a renewal,
    // etc.) — only a genuine tier change is notification-worthy here.
    if (!previous_plan || previous_plan === plan) {
      return { notified: false, org_id, reason: 'no_tier_change' as const }
    }

    await step.run('create-notification', async () => {
      const supabase = createServiceClient({ system: 'inngest:notify-plan-changed' })
      const today     = new Date().toISOString().split('T')[0]

      // Day-scoped dedupe key (matches notify-integration-error.ts's
      // pattern): a Stripe webhook retry of the SAME transition within the
      // day doesn't double-insert, but a genuinely repeated transition
      // later (upgrade -> downgrade -> upgrade again) still notifies.
      await createPmNotification(supabase, {
        orgId:     org_id,
        type:      'billing_plan_changed',
        title:     `Your plan changed to ${planName(plan)}`,
        subtitle:  `Previously ${planName(previous_plan)}`,
        href:      '/settings',
        severity:  'blue',
        dedupeKey: `plan-changed-${org_id}-${previous_plan}-${plan}-${today}`,
      })
    })

    return { notified: true, org_id, plan, previous_plan }
  }
)
