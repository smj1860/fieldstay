import { inngest }               from '@/lib/inngest/client'
import { createServiceClient }   from '@/lib/supabase/server'
import { resend, FROM }          from '@/lib/resend/client'
import { renderPmAlert }         from '@/lib/resend/emails/pm-alert'
import { createPmNotification, getPmMembers, type PmMember } from '@/lib/inngest/helpers'

/**
 * Hard ceiling on how many people one broken connection emails.
 *
 * Applied BOTH as the query limit and as a slice at the loop, which is not
 * belt-and-braces for its own sake: the query limit is an argument to
 * getPmMembers, so a change to that helper's behaviour would silently widen
 * this fan-out, and the step count of an Inngest run must not depend on a
 * distant default. The slice is also what makes the bound visible to
 * unit/guardrails/unbounded-fanout-loops.ts, which reads the loop's
 * collection at its DEFINITION rather than trusting a helper argument.
 */
const MAX_ALERT_RECIPIENTS = 10

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  ownerrez:   'OwnerRez',
  kroger:     'Kroger',
  hostaway:   'Hostaway',
  hospitable: 'Hospitable',
  ical:       'iCal',
}

export const notifyIntegrationError = inngest.createFunction(
  {
    id: 'notify-integration-error', name: 'Notify PM: Integration Connection Error', retries: 2,
    // Dispatched as an array from three separate sync paths — a provider
    // outage fails every connection at once, so this is precisely the case
    // where the alert storm would compound the incident it is reporting.
    concurrency: { limit: 5 },
    throttle:    { limit: 60, period: '1m' },
  },
  { event: 'integration/connection.error' as const },
  async ({ event, step }) => {
    const { org_id, provider_id, reason } = event.data

    await step.run('create-notification', async () => {
      const supabase     = createServiceClient({ system: 'inngest:notify-integration-error' })
      const providerName = PROVIDER_DISPLAY_NAMES[provider_id] ?? provider_id
      const today         = new Date().toISOString().split('T')[0]

      await createPmNotification(supabase, {
        orgId:     org_id,
        type:      'integration_connection_error',
        title:     `${providerName} connection needs attention`,
        subtitle:  reason,
        href:      '/settings/integrations',
        severity:  'red',
        dedupeKey: `integration-error-${org_id}-${provider_id}-${today}`,
      })
    })

    // ── AND AN EMAIL ─────────────────────────────────────────────────────────
    //
    // The bell alone was not enough, and the incident that prompted this shows
    // why: one org's Hospitable connection was dead for four days. A red badge
    // only works on a PM who happens to open FieldStay — and a PM whose syncs
    // have silently stopped has fewer reasons to, not more. This is the one
    // notification class where the whole point is reaching someone who is NOT
    // looking at the app.
    //
    // Transactional, not commercial: it reports a broken thing the recipient
    // asked us to run, and it carries no marketing content, so it does not go
    // through the CAN-SPAM opt-out gate that lib/email/commercial.ts guards.
    const recipients = await step.run('load-pm-recipients', async () => {
      const supabase = createServiceClient({ system: 'inngest:notify-integration-error' })
      return getPmMembers(supabase, org_id, {
        roles: ['owner', 'admin', 'manager'], limit: MAX_ALERT_RECIPIENTS,
      })
    })

    const providerName = PROVIDER_DISPLAY_NAMES[provider_id] ?? provider_id
    const appUrl       = process.env.NEXT_PUBLIC_APP_URL!
    // Same granularity as the notification's dedupe_key, so the bell and the
    // inbox agree on what "already told them today" means.
    const day = new Date().toISOString().split('T')[0]

    const targets = (recipients as PmMember[]).slice(0, MAX_ALERT_RECIPIENTS)

    for (const member of targets) {
      await step.run(`email-${member.userId}`, async () => {
        await resend.emails.send(
          {
            from:    FROM,
            to:      member.email,
            subject: `Action required — your ${providerName} connection stopped working`,
            html: await renderPmAlert({
              heading:  `${providerName} needs reconnecting`,
              body:
                `FieldStay can no longer reach your ${providerName} account, so turnovers, `
                + `calendars and crew are no longer syncing from it. Nothing already in `
                + `FieldStay has been lost — new changes on ${providerName} just are not `
                + `arriving. Reconnecting takes about a minute.`,
              ctaLabel: 'Reconnect →',
              ctaUrl:   `${appUrl}/settings/integrations`,
              details:  [{ label: 'What happened', value: reason }],
            }),
          },
          // Required by unit/guardrails/inngest-email-idempotency.ts. An Inngest
          // step is replayed on ANY failure, including one AFTER the send
          // succeeded, so without this a retry mails the PM twice about the
          // same dead connection.
          { idempotencyKey: `integration-error-${org_id}-${provider_id}-${day}-${member.userId}` }
        )
      })
    }

    return { notified: true, emailed: targets.length, org_id, provider_id }
  }
)
