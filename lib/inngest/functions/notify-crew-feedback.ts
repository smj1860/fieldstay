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

      const [cmResult, orgResult] = await Promise.all([
        // org-scoped like the vendor lookup in notify-vendor-compliance-
        // expiring.ts: this is a service-role read, so nothing else constrains
        // the crew_member_id the event carried to the org it also carried.
        supabase.from('crew_members').select('name').eq('id', crew_member_id).eq('org_id', org_id).single(),
        supabase.from('organizations').select('name').eq('id', org_id).single(),
      ])

      // PGRST116 = no matching row, a genuine "not found" — anything else is
      // a real query failure and should be retried, not silently swallowed.
      if (cmResult.error && cmResult.error.code !== 'PGRST116') {
        throw new Error(`crew_members query failed: ${cmResult.error.message}`)
      }
      if (orgResult.error && orgResult.error.code !== 'PGRST116') {
        throw new Error(`organizations query failed: ${orgResult.error.message}`)
      }

      const cm  = cmResult.data
      const org = orgResult.data

      // Keyed on the EVENT id, not a domain id: crew/feedback.submitted
      // carries no crew_feedback row id, and the only other candidate —
      // crew member plus text — would suppress a crew member who genuinely
      // sends the same short note twice ("app is slow"). Inngest's event id is
      // stable across step retries and distinct per submission, which is
      // exactly the identity wanted here.
      const { error } = await resend.emails.send({
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
      }, { idempotencyKey: `crew-feedback-${event.id}` })
      if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`)
    })

    return { notified: true, org_id, crew_member_id }
  }
)
