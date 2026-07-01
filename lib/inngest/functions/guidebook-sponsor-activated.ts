import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'
import { logAuditEvent } from '@/lib/audit'

export const guidebookSponsorActivated = inngest.createFunction(
  { id: 'guidebook-sponsor-activated', name: 'Guidebook: Sponsor Activated' },
  { event: 'guidebook/sponsor.checkout.completed' },
  async ({ event, step }) => {
    const { sponsorId, orgId, subscriptionId, customerId } = event.data

    await step.run('activate-sponsor-row', async () => {
      const supabase = createServiceClient()
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
      const supabase = createServiceClient()

      const { data: config } = await supabase
        .from('guidebook_configurations')
        .select('trial_ends_at')
        .eq('org_id', orgId)
        .maybeSingle()

      const inTrial = config?.trial_ends_at
        ? new Date() < new Date(config.trial_ends_at)
        : false

      if (!inTrial && activeSponsorCount < 3) return false

      await supabase
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
