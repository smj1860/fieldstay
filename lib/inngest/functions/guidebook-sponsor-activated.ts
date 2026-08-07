import { unwrap } from '@/lib/supabase/unwrap'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'

export const guidebookSponsorActivated = inngest.createFunction(
  { id: 'guidebook-sponsor-activated', name: 'Guidebook: Sponsor Activated' },
  { event: 'guidebook/sponsor.checkout.completed' },
  async ({ event, step }) => {
    const { sponsorId, orgId, subscriptionId, customerId } = event.data

    await step.run('activate-sponsor-row', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-sponsor-activated' })

      // Read before the write purely to catch the anomaly below. Replacing one
      // non-null subscription id with a DIFFERENT one means this sponsor now
      // has two live Stripe subscriptions and FieldStay can only ever see the
      // second — the first keeps billing the business monthly with nothing
      // here able to cancel it. createSponsorCheckoutSession now reuses an
      // open session and compare-and-swaps the new one, so our own flow should
      // not produce this; a subscription created outside it still can, and it
      // must not pass silently.
      const existingRes = await supabase
        .from('guidebook_sponsors')
        .select('stripe_subscription_id')
        .eq('id', sponsorId)
        .eq('org_id', orgId)
        .maybeSingle()

      const existing = unwrap(existingRes, {
        site: 'inngest.guidebook-sponsor-activated.existing-subscription', orgId,
      })

      const priorSubscriptionId = existing?.stripe_subscription_id ?? null
      if (priorSubscriptionId && priorSubscriptionId !== subscriptionId) {
        reportError(new Error('Sponsor activated with a second Stripe subscription'), {
          site:  'inngest.guidebook-sponsor-activated.duplicate-subscription',
          orgId,
          extra: { sponsor_id: sponsorId, prior_subscription_id: priorSubscriptionId, new_subscription_id: subscriptionId },
        })
      }

      const { error } = await supabase
        .from('guidebook_sponsors')
        .update({
          status:                 'active',
          stripe_subscription_id: subscriptionId,
          stripe_customer_id:     customerId,
          activated_at:           new Date().toISOString(),
          updated_at:             new Date().toISOString(),
        })
        .eq('id', sponsorId)
        .eq('org_id', orgId) // explicit tenant guard

      if (error) throw new Error(`Failed to activate sponsor: ${error.message}`)
    })

    const activeSponsorCount = await step.run('count-active-sponsors', async () => {
      return getActiveSponsorCount(orgId)
    })

    // Unlock guidebook when sponsor threshold is reached, or if the org is
    // still within their 30-day free trial. Also clears any in-progress grace
    // period — a replaced sponsor cancels the countdown.
    const wasUnlocked = await step.run('evaluate-guidebook-lock', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-sponsor-activated' })

      const configRes = await supabase
        .from('guidebook_configurations')
        .select('trial_ends_at')
        .eq('org_id', orgId)
        .maybeSingle()

      const config = unwrap(configRes, {
        site: 'inngest.guidebook-sponsor-activated.config', orgId,
      })

      const inTrial = config?.trial_ends_at
        ? new Date() < new Date(config.trial_ends_at)
        : false

      if (!inTrial && activeSponsorCount < 3) return false

      // Bound and thrown, matching the identical upsert in
      // guidebook-sponsor-payment-recovered. Discarded, a failed unlock left
      // the guidebook locked while this step returned `wasUnlocked: true` and
      // the audit row recorded an unlock that never happened — the sponsor
      // paid and the guidebook stayed dark.
      const { error } = await supabase
        .from('guidebook_configurations')
        .upsert(
          {
            org_id:               orgId,
            is_active:            true,
            grace_period_ends_at: null,
            updated_at:           new Date().toISOString(),
          },
          { onConflict: 'org_id' }
        )

      if (error) throw new Error(`Failed to unlock guidebook: ${error.message}`)

      return true
    })

    await step.run('log-audit-event', async () => {
      await logAuditEvent({
        orgId,
        action:     'guidebook.sponsor.activated',
        targetType: 'guidebook_sponsor',
        targetId:   sponsorId,
        metadata:   { activeSponsorCount, guidebookUnlocked: wasUnlocked },
      })
    })

    return { activeSponsorCount, sponsorId, orgId, wasUnlocked }
  }
)
