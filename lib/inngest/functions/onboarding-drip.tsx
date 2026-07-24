import { inngest }                                 from '@/lib/inngest/client'
import { createServiceClient }                     from '@/lib/supabase/server'
import { resend }                                  from '@/lib/resend/client'
import { renderWelcomeEmailV2 }                    from '@/emails/welcome-v2'
import { renderGuidebookFeatureAnnouncementEmail } from '@/emails/guidebook-feature-announcement'
import { renderReengagementEmail }                 from '@/emails/reengagement-drip'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'

// Personal sender drives opens — never the generic "FieldStay" FROM constant
const DRIP_FROM = 'Stephen from FieldStay <stephen@fieldstay.app>'

export const onboardingDrip = inngest.createFunction(
  {
    id:      'onboarding-drip',
    name:    'Onboarding: Email Drip Sequence',
    retries: 2,
    // One active drip per user — prevents duplicates if the event fires twice
    concurrency: { key: 'event.data.user_id', limit: 1 },
  },
  { event: 'user/onboarding.drip.started' },
  async ({ event, step, logger }) => {
    const { user_id, org_id, first_name, email, org_name } = event.data

    // ── Email 1: Immediate welcome ──────────────────────────────────────
    await step.run('send-welcome', async () => {
      try {
        const { error } = await resend.emails.send(
          {
            from:    DRIP_FROM,
            to:      email,
            replyTo: 'stephen@fieldstay.app',
            subject: "You made the right call. Here's where to start.",
            html:    await renderWelcomeEmailV2({
              firstName:       first_name,
              orgName:         org_name,
              integrationsUrl: `${APP_URL}/settings?tab=integrations`,
              onboardingUrl:   `${APP_URL}/onboarding`,
              dashboardUrl:    `${APP_URL}/ops`,
            }),
          },
          { idempotencyKey: `onboarding-welcome-${org_id}` }
        )
        if (error) {
          logger.error(`[Drip:${org_id}] Welcome email failed: ${JSON.stringify(error)}`)
        } else {
          logger.info(`[Drip:${org_id}] Email 1 (Welcome) sent`)
        }
      } catch (err) {
        logger.error(`[Drip:${org_id}] Welcome email threw: ${String(err)}`)
      }
    })

    // ── Wait 72 hours ─────────────────────────────────────────────────
    await step.sleep('wait-72h', '72h')

    // ── Email 2: Guidebook (existing template, repurposed) ─────────────
    const unsubscribedAt72h = await step.run('check-suppression-72h', async () => {
      const supabase = createServiceClient({ system: 'inngest:onboarding-drip' })
      const { data: profile } = await supabase
        .from('profiles')
        .select('email_unsubscribed_at')
        .eq('id', user_id)
        .maybeSingle()
      return profile?.email_unsubscribed_at ?? null
    })

    if (unsubscribedAt72h) {
      logger.info(`[Drip:${org_id}] User unsubscribed — stopping before Email 2`)
      return { stopped: true, reason: 'unsubscribed', emails_sent: 1 }
    }

    await step.run('send-guidebook', async () => {
      try {
        const { error } = await resend.emails.send(
          {
            from:    DRIP_FROM,
            to:      email,
            replyTo: 'stephen@fieldstay.app',
            subject: 'The Guidebook That Knows What Time It Is',
            html:    await renderGuidebookFeatureAnnouncementEmail({
              pmFirstName:  first_name,
              dashboardUrl: `${APP_URL}/guidebook`,
              launchDate:   'now',
            }),
          },
          { idempotencyKey: `onboarding-guidebook-${org_id}` }
        )
        if (error) {
          logger.error(`[Drip:${org_id}] Guidebook email failed: ${JSON.stringify(error)}`)
        } else {
          logger.info(`[Drip:${org_id}] Email 2 (Guidebook) sent`)
        }
      } catch (err) {
        logger.error(`[Drip:${org_id}] Guidebook email threw: ${String(err)}`)
      }
    })

    // ── Wait 96 more hours (168h / 7 days total) ──────────────────────
    await step.sleep('wait-96h', '96h')

    // ── Email 3: Behavioral split on PMS connection ────────────────────
    const unsubscribedAt168h = await step.run('check-suppression-168h', async () => {
      const supabase = createServiceClient({ system: 'inngest:onboarding-drip' })
      const { data: profile } = await supabase
        .from('profiles')
        .select('email_unsubscribed_at')
        .eq('id', user_id)
        .maybeSingle()
      return profile?.email_unsubscribed_at ?? null
    })

    if (unsubscribedAt168h) {
      logger.info(`[Drip:${org_id}] User unsubscribed — sequence complete`)
      return { stopped: true, reason: 'unsubscribed', emails_sent: 2 }
    }

    const isConnected = await step.run('check-pms-connection', async () => {
      const supabase = createServiceClient({ system: 'inngest:onboarding-drip' })
      const { data: connections } = await supabase
        .from('integration_connections')
        .select('provider_id')
        .eq('org_id', org_id)
        .eq('status', 'active')
        .limit(1)
      return (connections?.length ?? 0) > 0
    })

    await step.run('send-reengagement', async () => {
      try {
        const { error } = await resend.emails.send(
          {
            from:    DRIP_FROM,
            to:      email,
            replyTo: 'stephen@fieldstay.app',
            subject: isConnected
              ? 'Your guests left reviews this week. Did you respond?'
              : "7 days in. Here's what you're missing.",
            html:    await renderReengagementEmail({
              firstName:       first_name,
              orgName:         org_name,
              isConnected,
              dashboardUrl:    `${APP_URL}/ops`,
              integrationsUrl: `${APP_URL}/settings?tab=integrations`,
              onboardingUrl:   `${APP_URL}/onboarding`,
              reviewCount:     3,
            }),
          },
          { idempotencyKey: `onboarding-reengagement-${org_id}` }
        )
        if (error) {
          logger.error(`[Drip:${org_id}] Reengagement email failed: ${JSON.stringify(error)}`)
        } else {
          logger.info(`[Drip:${org_id}] Email 3 (Re-engagement, connected=${isConnected}) sent`)
        }
      } catch (err) {
        logger.error(`[Drip:${org_id}] Reengagement email threw: ${String(err)}`)
      }
    })

    return { org_id, emails_sent: 3, variant: isConnected ? 'connected' : 'not_connected' }
  }
)
