import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'

export const guidebookGraceExpiredHandler = inngest.createFunction(
  {
    id:   'guidebook-grace-expired-handler',
    name: 'Guidebook: Grace Period Expired',
  },
  { event: 'guidebook/grace.period.expired' },
  async ({ event, step }) => {
    const { orgId } = event.data
    const supabase  = createServiceClient()

    const activeSponsorCount = await step.run('count-active-sponsors', async () => {
      return getActiveSponsorCount(orgId)
    })

    // If the PM filled the slot during the grace period, clear it and do nothing
    if (activeSponsorCount >= 4) {
      await step.run('clear-grace-period', async () => {
        await supabase
          .from('guidebook_configurations')
          .update({
            grace_period_ends_at: null,
            updated_at:           new Date().toISOString(),
          })
          .eq('org_id', orgId)
      })
      return { locked: false, reason: 'sponsor_replaced', activeSponsorCount }
    }

    // Grace period expired with insufficient sponsors — lock the guidebook
    await step.run('lock-guidebook', async () => {
      await supabase
        .from('guidebook_configurations')
        .update({
          is_active:            false,
          grace_period_ends_at: null,
          updated_at:           new Date().toISOString(),
        })
        .eq('org_id', orgId)
    })

    return { locked: true, orgId, activeSponsorCount }
  }
)
