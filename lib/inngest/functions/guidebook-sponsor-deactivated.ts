import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'

export const guidebookSponsorDeactivated = inngest.createFunction(
  { id: 'guidebook-sponsor-deactivated', name: 'Guidebook: Sponsor Deactivated' },
  [
    { event: 'guidebook/sponsor.subscription.cancelled' },
    { event: 'guidebook/sponsor.payment.failed' },
  ],
  async ({ event, step }) => {
    const { sponsorId, orgId } = event.data
    const isCancelled = event.name === 'guidebook/sponsor.subscription.cancelled'
    const supabase    = createServiceClient()

    await step.run('deactivate-sponsor-row', async () => {
      const { error } = await supabase
        .from('guidebook_sponsors')
        .update({
          status:         isCancelled ? 'cancelled' : 'payment_failed',
          deactivated_at: new Date().toISOString(),
          updated_at:     new Date().toISOString(),
        })
        .eq('id', sponsorId)
        .eq('org_id', orgId)

      if (error) throw new Error(`Failed to deactivate sponsor: ${error.message}`)
    })

    const activeSponsorCount = await step.run('count-active-sponsors', async () => {
      return getActiveSponsorCount(orgId)
    })

    // Sponsor count dropped below the threshold — open a 5-day grace period
    // instead of locking immediately. Gives the PM time to replace the
    // sponsor, or the sponsor time to resolve a failed payment, without
    // losing guidebook access. guidebook-grace-expired-handler resolves it.
    await step.run('evaluate-guidebook-lock', async () => {
      if (activeSponsorCount >= 4) return

      const gracePeriodEndsAt = new Date(
        Date.now() + 5 * 24 * 60 * 60 * 1000
      ).toISOString()

      await supabase
        .from('guidebook_configurations')
        .update({
          grace_period_ends_at: gracePeriodEndsAt,
          updated_at:           new Date().toISOString(),
        })
        .eq('org_id', orgId)
        .eq('is_active', true) // no-op if already locked
    })

    return { activeSponsorCount, sponsorId, orgId }
  }
)
