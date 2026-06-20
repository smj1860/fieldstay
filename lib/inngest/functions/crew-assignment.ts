import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM }        from '@/lib/resend/client'
import { formatDateTime }      from '@/lib/utils'

/**
 * Triggered when one or more turnovers are assigned to a crew member via
 * the Turnover Board (assignCrew or addCrewToTurnover). Sends a single
 * consolidated email regardless of push subscription status — email is
 * the reliable fallback channel since push requires PWA install + permission.
 *
 * Idempotency: keyed by crew_member_id + turnover_ids in the event payload.
 * Re-assigning the same crew member to the same turnover will re-send —
 * this is acceptable (informational, not transactional) and matches the
 * existing push notification behavior.
 */
export const handleCrewAssigned = inngest.createFunction(
  {
    id:      'turnover-crew-assigned',
    name:    'Notify Crew of Turnover Assignment',
    retries: 2,
  },
  { event: 'turnover/crew-assigned' as const },
  async ({ event, step }) => {
    const { crew_member_id, turnover_ids, org_id } = event.data

    const { crew, turnovers } = await step.run('fetch-assignment-data', async () => {
      const supabase = createServiceClient()

      const [{ data: crew }, { data: turnovers }] = await Promise.all([
        supabase
          .from('crew_members')
          .select('id, name, email')
          .eq('id', crew_member_id)
          .eq('org_id', org_id)
          .single(),
        supabase
          .from('turnovers')
          .select(`
            id, checkout_datetime, checkin_datetime, window_minutes, priority,
            properties ( name )
          `)
          .in('id', turnover_ids)
          .eq('org_id', org_id),
      ])

      return { crew, turnovers: turnovers ?? [] }
    })

    if (!crew?.email || turnovers.length === 0) {
      return { skipped: true, reason: !crew?.email ? 'no-email' : 'no-turnovers' }
    }

    await step.run('send-assignment-email', async () => {
      const rows = turnovers
        .map(t => {
          const prop        = Array.isArray(t.properties) ? t.properties[0] : t.properties
          const windowHours = Math.round((t.window_minutes ?? 0) / 60)
          return `
            <tr>
              <td style="padding:8px;border-bottom:1px solid #e2e8f0">${prop?.name ?? 'Property'}</td>
              <td style="padding:8px;border-bottom:1px solid #e2e8f0">${formatDateTime(t.checkout_datetime)}</td>
              <td style="padding:8px;border-bottom:1px solid #e2e8f0">${windowHours}h</td>
              <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-transform:uppercase;font-size:12px;color:${t.priority === 'urgent' || t.priority === 'high' ? '#b45309' : '#64748b'}">${t.priority}</td>
            </tr>
          `
        })
        .join('')

      const subject = turnovers.length === 1
        ? `Turnover assigned — ${(Array.isArray(turnovers[0]!.properties) ? turnovers[0]!.properties[0] : turnovers[0]!.properties)?.name ?? 'Property'}`
        : `${turnovers.length} turnovers assigned to you`

      await resend.emails.send({
        from:    FROM,
        to:      crew.email,
        subject,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <h2>You've been assigned ${turnovers.length === 1 ? 'a turnover' : `${turnovers.length} turnovers`}</h2>
            <table style="border-collapse:collapse;width:100%;margin:16px 0">
              <thead>
                <tr style="text-align:left;color:#64748b;font-size:12px">
                  <th style="padding:8px">Property</th>
                  <th style="padding:8px">Checkout</th>
                  <th style="padding:8px">Window</th>
                  <th style="padding:8px">Priority</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
            <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/crew" style="background:#093b31;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block">View Assignments →</a></p>
          </div>
        `,
      })
    })

    return { notified: true, crew_member_id, count: turnovers.length }
  }
)
