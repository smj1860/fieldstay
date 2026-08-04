// Triggered when notifyCrewOfCancelledTurnovers() (lib/turnovers/generator.ts)
// fires after a booking cancellation/deletion cancels one or more assigned
// turnovers out from under a crew member. Push + SMS only, deliberately no
// email — this needs to reach the crew member before they act (e.g. drive
// to a property that no longer needs cleaning), not sit in an inbox.
//
// Idempotency: keyed by crew_member_id + turnover_ids in the event payload,
// same model as turnover/crew-assigned — re-firing for the same cancelled
// set will re-send, which is acceptable for a time-sensitive stand-down
// notice (better to over-notify than under-notify here).

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { renderSmsBody }       from '@/lib/sms/templates'
import { reportError }         from '@/lib/observability/report-error'

export const handleCrewTurnoverCancelled = inngest.createFunction(
  {
    id:      'turnover-crew-cancelled',
    name:    'Notify Crew of Turnover Cancellation',
    retries: 2,
    // Burst-exposed AND sends through an external provider. Resend's default
    // is 2 req/s, so throttle to 1/s: this handler receives a BATCH of events
    // (see the sender), and without a cap the whole batch lands at once.
    concurrency: { limit: 5 },
    throttle:    { limit: 60, period: '1m' },
  },
  { event: 'turnover/cancelled' as const },
  async ({ event, step }) => {
    const { crew_member_id, turnover_ids, org_id } = event.data

    const { crew, org } = await step.run('fetch-notify-data', async () => {
      const supabase = createServiceClient({ system: 'inngest:crew-turnover-cancelled' })

      const [{ data: crew }, { data: org }] = await Promise.all([
        supabase
          .from('crew_members')
          .select('id, phone')
          .eq('id', crew_member_id)
          .eq('org_id', org_id)
          .single(),
        supabase
          .from('organizations')
          .select('name')
          .eq('id', org_id)
          .single(),
      ])

      return { crew, org }
    })

    if (!crew) {
      return { skipped: true, reason: 'crew-not-found' }
    }

    const count = turnover_ids.length
    const title = count === 1 ? 'Turnover cancelled' : `${count} turnovers cancelled`
    const body  = count === 1
      ? 'A cancelled booking removed your assigned turnover. No need to go.'
      : `A cancelled booking removed ${count} of your assigned turnovers. No need to go.`

    // Push — fastest channel, most likely to reach a crew member already
    // en route or about to leave. Crew push subscriptions are keyed by
    // crew_member_id (app/api/crew/push-subscribe/route.ts), not user_id —
    // crew_members.user_id is often null for crew onboarded outside the
    // invite-link flow, same caveat as requireCrewMember()'s
    // invite_accepted_at note in CLAUDE.md.
    await step.run('push-cancellation', async () => {
      const supabase = createServiceClient({ system: 'inngest:crew-turnover-cancelled' })
      const { data: subs } = await supabase
        .from('push_subscriptions')
        .select('endpoint, p256dh, auth')
        .eq('crew_member_id', crew_member_id)

      if (!subs?.length) return { sent: false, reason: 'no-subscriptions' }

      const { sendPushToCrewMember } = await import('@/lib/push/client')
      await sendPushToCrewMember(subs, {
        title,
        body,
        url: '/crew',
      }).catch((err) => {
        console.error('[handleCrewTurnoverCancelled] push failed (non-fatal):', err)
        reportError(err, { site: 'inngest.crew-turnover-cancelled.push', orgId: org_id, extra: { crew_member_id } })
      })

      return { sent: true }
    })

    // SMS — dependable fallback that doesn't need the PWA open.
    if (crew.phone) {
      await step.run('sms-cancellation', async () => {
        const { normalizePhoneToE164, sendSMS } = await import('@/lib/sms/telnyx')

        const e164 = normalizePhoneToE164(crew.phone!)
        if (!e164) return { skipped: true, reason: 'invalid-phone' }

        const smsBody = await renderSmsBody(org_id, 'crew_turnover_cancelled', {
          org_name: org?.name ?? 'Your property manager',
          count:    String(count),
        }, [])

        try {
          await sendSMS(e164, smsBody, { orgId: org_id })
        } catch (smsErr) {
          console.error('[handleCrewTurnoverCancelled] SMS failed (non-fatal):', smsErr)
          reportError(smsErr, { site: 'inngest.crew-turnover-cancelled.sms', orgId: org_id, extra: { crew_member_id } })
          return { sent: false, reason: 'send-failed' }
        }
        return { sent: true }
      })
    }

    return { notified: true, crew_member_id, count }
  }
)
