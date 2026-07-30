import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM }        from '@/lib/resend/client'
import { renderPmAlert }       from '@/lib/resend/emails/pm-alert'

export const notifyCrewFeedback = inngest.createFunction(
  { id: 'notify-crew-feedback', name: 'Notify Platform Staff: Crew Feedback Submitted', retries: 3 },
  { event: 'crew/feedback.submitted' as const },
  async ({ event, step }) => {
    const { org_id, crew_member_id, feedback_text } = event.data

    await step.run('send-staff-notification', async () => {
      const supabase = createServiceClient({ system: 'inngest:notify-crew-feedback' })

      const [{ data: cm }, { data: org }] = await Promise.all([
        supabase.from('crew_members').select('name').eq('id', crew_member_id).single(),
        supabase.from('organizations').select('name').eq('id', org_id).single(),
      ])

      await resend.emails.send({
        from:    FROM,
        to:      'stephen@fieldstay.app',
        subject: `New crew feedback from ${cm?.name ?? 'a crew member'}`,
        html: await renderPmAlert({
          heading: 'New crew feedback submitted',
          body:    feedback_text,
          details: [
            { label: 'Crew member',  value: cm?.name ?? null },
            { label: 'Organization', value: org?.name ?? null },
          ],
          ctaLabel: 'View in Support Inbox →',
          ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/support-inbox`,
        }),
      })
    })

    return { notified: true, org_id, crew_member_id }
  }
)
