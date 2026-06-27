import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'

export const guidebookSponsorActivated = inngest.createFunction(
  { id: 'guidebook-sponsor-activated', name: 'Guidebook: Sponsor Activated' },
  { event: 'guidebook/sponsor.checkout.completed' },
  async ({ event, step }) => {
    const { sponsorId, orgId, subscriptionId, customerId } = event.data
    const supabase = createServiceClient()

    await step.run('activate-sponsor-row', async () => {
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

    // Unlock guidebook when sponsor wall threshold is reached. Also clears
    // any in-progress grace period — a replaced sponsor cancels the countdown.
    await step.run('evaluate-guidebook-lock', async () => {
      if (activeSponsorCount < 4) return

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
    })

    return { activeSponsorCount, sponsorId, orgId }
  }
)
