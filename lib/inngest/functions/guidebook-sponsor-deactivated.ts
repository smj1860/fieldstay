import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'
import { getOrgPmEmails } from '@/lib/guidebook/pm-emails'
import { sendGuidebookGracePeriodEmail } from '@/lib/resend/client'
import { logAuditEvent } from '@/lib/audit'

export const guidebookSponsorDeactivated = inngest.createFunction(
  { id: 'guidebook-sponsor-deactivated', name: 'Guidebook: Sponsor Deactivated' },
  [
    { event: 'guidebook/sponsor.subscription.cancelled' },
    { event: 'guidebook/sponsor.payment.failed' },
  ],
  async ({ event, step }) => {
    const { sponsorId, orgId } = event.data
    const isCancelled = event.name === 'guidebook/sponsor.subscription.cancelled'

    await step.run('deactivate-sponsor-row', async () => {
      const supabase = createServiceClient()
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
    const gracePeriodEndsAt = await step.run('evaluate-guidebook-lock', async () => {
      if (activeSponsorCount >= 3) return null

      const supabase = createServiceClient()
      const { data: existingConfig } = await supabase
        .from('guidebook_configurations')
        .select('is_active, grace_period_ends_at')
        .eq('org_id', orgId)
        .maybeSingle()

      // Already locked, or a grace period is already running — don't reset
      // the countdown or re-notify the PM on a second deactivation event.
      if (!existingConfig?.is_active) return null
      if (existingConfig.grace_period_ends_at) return null

      const endsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()

      await supabase
        .from('guidebook_configurations')
        .update({
          grace_period_ends_at: endsAt,
          updated_at:           new Date().toISOString(),
        })
        .eq('org_id', orgId)
        .eq('is_active', true)

      return endsAt
    })

    if (gracePeriodEndsAt) {
      await step.run('notify-pm-grace-period', async () => {
        const { emails, orgName } = await getOrgPmEmails(orgId)
        if (emails.length === 0) return

        const guidebookUrl = `${process.env.NEXT_PUBLIC_APP_URL}/guidebook`

        await Promise.all(
          emails.map((toEmail) =>
            sendGuidebookGracePeriodEmail({
              toEmail,
              orgName,
              activeSponsors:    activeSponsorCount,
              gracePeriodEndsAt,
              guidebookUrl,
            })
          )
        )
      })
    }

    await step.run('log-audit-event', async () => {
      await logAuditEvent({
        orgId,
        action:     isCancelled ? 'guidebook.sponsor.cancelled' : 'guidebook.sponsor.payment_failed',
        targetType: 'guidebook_sponsor',
        targetId:   sponsorId,
        metadata:   { activeSponsorCount, gracePeriodEndsAt: gracePeriodEndsAt ?? null },
      })
    })

    return { activeSponsorCount, sponsorId, orgId }
  }
)
