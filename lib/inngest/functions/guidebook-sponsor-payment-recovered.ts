import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'
import { logAuditEvent } from '@/lib/audit'

export const guidebookSponsorPaymentRecovered = inngest.createFunction(
  { id: 'guidebook-sponsor-payment-recovered', name: 'Guidebook: Sponsor Payment Recovered' },
  { event: 'guidebook/sponsor.payment.recovered' },
  async ({ event, step }) => {
    const { sponsorId, orgId } = event.data
    const supabase = createServiceClient()

    await step.run('reactivate-sponsor-row', async () => {
      const { error } = await supabase
        .from('guidebook_sponsors')
        .update({
          status:         'active',
          deactivated_at: null,
          updated_at:     new Date().toISOString(),
        })
        .eq('id', sponsorId)
        .eq('org_id', orgId)

      if (error) throw new Error(`Failed to reactivate sponsor: ${error.message}`)
    })

    const activeSponsorCount = await step.run('count-active-sponsors', async () => {
      return getActiveSponsorCount(orgId)
    })

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

    await step.run('log-audit-event', async () => {
      await logAuditEvent({
        orgId,
        action:     'guidebook.sponsor.payment_recovered',
        targetType: 'guidebook_sponsor',
        targetId:   sponsorId,
        metadata:   { activeSponsorCount, guidebookUnlocked: activeSponsorCount >= 4 },
      })
    })

    return { activeSponsorCount, sponsorId, orgId }
  }
)
