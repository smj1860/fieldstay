import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { unwrapCount }          from '@/lib/supabase/unwrap'
import { PLANS, type PlanKey }  from '@/lib/stripe/client'

function planName(plan: string): string {
  return plan in PLANS ? PLANS[plan as PlanKey].name : plan
}

function planCap(plan: string): number | null {
  return plan in PLANS ? PLANS[plan as PlanKey].maxProperties : null
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

    // ── Over-cap check ────────────────────────────────────────────────────
    // createCheckoutSession refuses a plan that does not cover the org's
    // existing properties, but that only guards OUR checkout — and it sends
    // anyone with a live subscription to the Stripe billing portal, which is
    // therefore where most plan changes actually happen. A downgrade made
    // there is already done by the time this event fires, so it cannot be
    // blocked; it can only be surfaced.
    //
    // Left unsurfaced it is silent: max_properties is written straight from
    // PLANS[plan].maxProperties, existing properties keep working (the cap is
    // only enforced when ADDING one), and the org just quietly pays for less
    // than it uses. The only visible symptom is a confusing "your plan allows
    // up to N properties" error the next time they try to add one.
    const overCap = await step.run('check-property-cap', async () => {
      const cap = planCap(plan)
      if (cap === null) return null

      const supabase = createServiceClient({ system: 'inngest:notify-plan-changed' })
      // head+count — ships no rows, so max_rows cannot truncate it.
      const res = await supabase
        .from('properties')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', org_id)
        .eq('is_active', true)

      const count = unwrapCount(res, { site: 'inngest.notify-plan-changed.property-cap', orgId: org_id })
      return count > cap ? { count, cap } : null
    })

    if (overCap) {
      await step.run('notify-over-cap', async () => {
        const supabase = createServiceClient({ system: 'inngest:notify-plan-changed' })

        await createPmNotification(supabase, {
          orgId:    org_id,
          type:     'billing_plan_over_capacity',
          title:    `${planName(plan)} covers fewer properties than you have`,
          subtitle:
            // Always plural — reaching here needs count > cap, and the
            // smallest plan's cap is 4, so count is at least 5.
            `You have ${overCap.count} active properties but ${planName(plan)} covers up to ` +
            `${overCap.cap}. Existing properties keep working, but you cannot add more until you upgrade.`,
          href:     '/settings?tab=billing',
          severity: 'amber',
          // Keyed on the state, not the day: this is a standing condition
          // rather than an event, so re-notifying daily would be nagging.
          // A further change of plan or property count re-notifies, which is
          // right — that is a different state.
          dedupeKey: `plan-over-cap-${org_id}-${plan}-${overCap.count}`,
        })
      })
    }

    return { notified: true, org_id, plan, previous_plan, overCapacity: overCap !== null }
  }
)
