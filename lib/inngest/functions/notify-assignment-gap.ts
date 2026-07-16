import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM }        from '@/lib/resend/client'
import { escapeHtml }          from '@/lib/utils/html'
import { getPmMembers, type PmMember } from '@/lib/inngest/helpers'

export const notifyAssignmentGap = inngest.createFunction(
  { id: 'notify-assignment-gap', name: 'Notify PM: Crew Coverage Gap', retries: 2 },
  { event: 'crew/assignment-gap' as const },
  async ({ event, step }) => {
    const { turnover_id, property_id, org_id, turnover_date, crew_needed, crew_found } = event.data

    const context = await step.run('load-context', async () => {
      const supabase = createServiceClient()

      const [{ data: property }, pmMembers] = await Promise.all([
        supabase.from('properties').select('name').eq('id', property_id).eq('org_id', org_id).single(),
        getPmMembers(supabase, org_id, { roles: ['owner', 'admin', 'manager'], limit: 10 }),
      ])

      return {
        propertyName: property?.name ?? 'Property',
        pmMembers,   // [{ userId, email, role }] — reasonable ceiling of 10; orgs with more are an edge case
      }
    })

    if (!context.pmMembers.length) return { sent: 0, reason: 'no_managers' }

    const sentTo: string[] = []

    for (const member of context.pmMembers as PmMember[]) {
      const sent = await step.run(`notify-manager-${member.userId}`, async () => {
        const appUrl  = process.env.NEXT_PUBLIC_APP_URL!
        const dateStr = new Date(turnover_date).toLocaleDateString('en-US', {
          weekday: 'long', month: 'short', day: 'numeric',
        })

        await resend.emails.send(
          {
            from:    FROM,
            to:      member.email,
            subject: `Action required — No crew available for ${context.propertyName} on ${dateStr}`,
            html: `
              <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
                <h2>Crew coverage gap</h2>
                <p>
                  ${escapeHtml(context.propertyName)} has a turnover scheduled for
                  <strong>${dateStr}</strong> with no available crew member to
                  auto-assign (needed ${crew_needed}, found ${crew_found}).
                </p>
                <p>This turnover is unassigned and waiting on manual assignment.</p>
                <p>
                  <a href="${appUrl}/turnovers/${turnover_id}"
                     style="background:#093b31;color:white;padding:10px 20px;
                            text-decoration:none;border-radius:6px;display:inline-block">
                    View Turnover →
                  </a>
                </p>
              </div>
            `,
          },
          { idempotencyKey: `assignment-gap-${turnover_id}-${member.userId}` }
        )

        return member.email
      })

      if (sent) sentTo.push(sent)
    }

    // Push notifications (best-effort — don't fail the function if push errors)
    for (const member of context.pmMembers as PmMember[]) {
      await step.run(`push-manager-${member.userId}`, async () => {
        const supabase = createServiceClient()
        const { data: subs } = await supabase
          .from('push_subscriptions')
          .select('endpoint, p256dh, auth')
          .eq('user_id', member.userId)

        if (!subs?.length) return

        const { sendPushToCrewMember } = await import('@/lib/push/client')
        await sendPushToCrewMember(subs, {
          title: `No crew for ${context.propertyName}`,
          body:  `Turnover on ${new Date(turnover_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} needs manual assignment`,
          url:   `/turnovers/${turnover_id}`,
        }).catch(() => { /* silently skip failed pushes */ })
      })
    }

    return { sent: sentTo.length, recipients: sentTo }
  }
)
