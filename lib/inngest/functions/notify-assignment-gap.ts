import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM }        from '@/lib/resend/client'
import { renderPmAlert }       from '@/lib/resend/emails/pm-alert'
import { getPmMembers, type PmMember } from '@/lib/inngest/helpers'
import { throwIfAnyQueryFailed, isRealQueryError, unwrapList } from '@/lib/supabase/unwrap'

/**
 * What to tell the PM when a filter — not the scorer — emptied the pool.
 *
 * Keyed by the event's optional `reason`. Each string names the lever the PM
 * can actually pull, because the counts alone ("found 0") describe a symptom
 * that looks identical whether they have no crew or have excluded all of them.
 */
const GAP_REASON_COPY: Record<'none_eligible' | 'all_unavailable', string> = {
  none_eligible:
    'Every active crew member is currently switched OFF for turnover ' +
    'auto-assignment — turn someone back on from Manage Crew, or assign this ' +
    'turnover by hand.',
  all_unavailable:
    'Every crew member eligible for auto-assignment has marked this date as ' +
    'time off.',
}

export const notifyAssignmentGap = inngest.createFunction(
  { id: 'notify-assignment-gap', name: 'Notify PM: Crew Coverage Gap', retries: 2 },
  { event: 'crew/assignment-gap' as const },
  async ({ event, step }) => {
    const { turnover_id, property_id, org_id, turnover_date, crew_needed, crew_found, reason } = event.data

    // "No crew available" on an org with five cleaners reads as a bug in
    // FieldStay, and a PM who reads it that way does nothing. Naming the filter
    // that emptied the pool turns the same alert into an instruction.
    //
    // Absent for a gap the scorer produced on its own, which is the original
    // path and needs no explanation beyond the counts already in the body.
    const reasonLine = reason ? `${GAP_REASON_COPY[reason]} ` : ''

    const context = await step.run('load-context', async () => {
      const supabase = createServiceClient({ system: 'inngest:notify-assignment-gap' })

      const [{ data: property, error: propertyError }, pmMembers] = await Promise.all([
        supabase.from('properties').select('name').eq('id', property_id).eq('org_id', org_id).single(),
        getPmMembers(supabase, org_id, { roles: ['owner', 'admin', 'manager'], limit: 10 }),
      ])
      throwIfAnyQueryFailed(
        { site: 'inngest.notify-assignment-gap.load-context', orgId: org_id },
        isRealQueryError(propertyError) ? propertyError : null,
      )

      return {
        propertyName: property?.name ?? 'Property',
        pmMembers,   // [{ userId, email, role }] — reasonable ceiling of 10; orgs with more are an edge case
      }
    })

    if (!context.pmMembers.length) return { sent: 0, reason: 'no_managers' }

    // User ids, not email addresses. An Inngest function's return value is
    // persisted and rendered in the run history, so returning `recipients:
    // ['pm@example.com', ...]` put PM email addresses into a third-party
    // console — the same rule as the log ban in CLAUDE.md, just a surface
    // that is easy to forget is durable.
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
            html: await renderPmAlert({
              heading:  'Crew coverage gap',
              body:     `${context.propertyName} has a turnover scheduled for ${dateStr} with no available crew member to auto-assign (needed ${crew_needed}, found ${crew_found}).${reasonLine} This turnover is unassigned and waiting on manual assignment.`,
              ctaLabel: 'View Turnover →',
              ctaUrl:   `${appUrl}/turnovers/${turnover_id}`,
            }),
          },
          { idempotencyKey: `assignment-gap-${turnover_id}-${member.userId}` }
        )

        return member.userId
      })

      if (sent) sentTo.push(sent)
    }

    // Push notifications (best-effort — don't fail the function if push errors)
    for (const member of context.pmMembers as PmMember[]) {
      await step.run(`push-manager-${member.userId}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:notify-assignment-gap' })
        const subsRes = await supabase
          .from('push_subscriptions')
          .select('endpoint, p256dh, auth')
          .eq('user_id', member.userId)
          // Bounded: one manager's own registered devices.
          .limit(20)
        const subs = unwrapList(subsRes, { site: 'inngest.notify-assignment-gap.push-manager', orgId: org_id })

        if (!subs.length) return

        const { sendPushToCrewMember } = await import('@/lib/push/client')
        await sendPushToCrewMember(subs, {
          title: `No crew for ${context.propertyName}`,
          body:  `Turnover on ${new Date(turnover_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} needs manual assignment`,
          url:   `/turnovers/${turnover_id}`,
        }).catch(() => { /* silently skip failed pushes */ })
      })
    }

    return { sent: sentTo.length, recipientUserIds: sentTo }
  }
)
