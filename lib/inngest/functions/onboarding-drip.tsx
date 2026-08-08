import { unwrapCount, unwrapList } from '@/lib/supabase/unwrap'
import { inngest }                                 from '@/lib/inngest/client'
import { createServiceClient }                     from '@/lib/supabase/server'
import { resend }                                  from '@/lib/resend/client'
import { renderWelcomeEmailV2 }                    from '@/emails/welcome-v2'
import { renderGuidebookFeatureAnnouncementEmail } from '@/emails/guidebook-feature-announcement'
import { renderReengagementEmail }                 from '@/emails/reengagement-drip'

import { reportError } from '@/lib/observability/report-error'
import { resolveEmailAudience, commercialPostalAddress } from '@/lib/email/unsubscribe'
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'

// Personal sender drives opens — never the generic "FieldStay" FROM constant
const DRIP_FROM = 'Stephen from FieldStay <stephen@fieldstay.app>'

/**
 * Subject line for email 3. Three variants, not two: the reviews subject
 * asks "Did you respond?", which presumes reviews arrived, so it cannot be
 * used for a connected org whose real count is zero.
 */
function subjectForReengagement(isConnected: boolean, reviewCount: number): string {
  if (!isConnected) return "7 days in. Here's what you're missing."
  if (reviewCount > 0) return 'Your guests left reviews this week. Did you respond?'
  return 'One week in. FieldStay is watching your reviews.'
}

/**
 * The Resend SDK returns `{ data, error }` for API-level failures and only
 * throws for transport ones — so `if (error)` is the COMMON failure shape, and
 * it was the one branch that never reached Sentry: the `catch` called
 * reportError, the `if (error)` wrote a log line and moved on. Every real send
 * failure was therefore invisible outside Axiom, while the function still
 * returned `emails_sent: 3`.
 *
 * Deliberately still not thrown. Unlike a broadcast, this sequence cannot be
 * re-run — a failed step that exhausts retries kills the remaining emails and
 * their 72h/96h sleeps with it, and losing emails 2 and 3 to a transient
 * failure on email 1 is worse than sending fewer. So the failure is made
 * VISIBLE and counted, and the function's return value stops overstating
 * what it sent.
 *
 * `error.name` only, never JSON.stringify(error): a Resend validation error
 * echoes the offending `to` address back in its message, and CLAUDE.md bans
 * email addresses from logs. The full object goes to Sentry instead.
 */
function reportSendFailure(
  logger: { error: (msg: string) => void },
  label:  string,
  orgId:  string,
  error:  unknown,
): void {
  const name = (error as { name?: string } | null)?.name ?? 'unknown_error'
  logger.error(`[Drip:${orgId}] ${label} email failed: ${name}`)
  reportError(error, { site: `inngest.onboarding-drip.${label.toLowerCase()}`, orgId })
}

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
    // Checked even though the user just signed up: the drip event can be
    // re-sent, and someone who opted out on a previous account must not be
    // mailed again. This also supplies the opt-out link that lets them stop
    // emails 2 and 3 — without it the suppression checks below are unreachable
    // by any actual human, which is precisely the state this sequence shipped in.
    const audienceWelcome = await step.run('check-suppression-welcome', async () => {
      const supabase = createServiceClient({ system: 'inngest:onboarding-drip' })
      return resolveEmailAudience(supabase, user_id)
    })

    if (audienceWelcome.suppressed) {
      logger.info(`[Drip:${org_id}] User suppressed — no drip emails sent`)
      return { stopped: true, reason: 'unsubscribed', emails_sent: 0 }
    }

    const sentWelcome = await step.run('send-welcome', async () => {
      try {
        const { error } = await resend.emails.send(
          {
            from:    DRIP_FROM,
            to:      email,
            replyTo: 'stephen@fieldstay.app',
            subject: "You made the right call. Here's where to start.",
            headers: audienceWelcome.headers,
            html:    await renderWelcomeEmailV2({
              firstName:       first_name,
              orgName:         org_name,
              integrationsUrl: `${APP_URL}/settings?tab=integrations`,
              onboardingUrl:   `${APP_URL}/onboarding`,
              dashboardUrl:    `${APP_URL}/ops`,
              unsubscribeUrl:  audienceWelcome.unsubscribeUrl ?? undefined,
              postalAddress:   commercialPostalAddress(),
            }),
          },
          { idempotencyKey: `onboarding-welcome-${org_id}` }
        )
        if (error) {
          reportSendFailure(logger, 'Welcome', org_id, error)
          return false
        }
        logger.info(`[Drip:${org_id}] Email 1 (Welcome) sent`)
        return true
      } catch (err) {
        reportSendFailure(logger, 'Welcome', org_id, err)
        return false
      }
    })

    // ── Wait 72 hours ─────────────────────────────────────────────────
    await step.sleep('wait-72h', '72h')

    // ── Email 2: Guidebook (existing template, repurposed) ─────────────
    const audience72h = await step.run('check-suppression-72h', async () => {
      const supabase = createServiceClient({ system: 'inngest:onboarding-drip' })
      return resolveEmailAudience(supabase, user_id)
    })

    if (audience72h.suppressed) {
      logger.info(`[Drip:${org_id}] User unsubscribed — stopping before Email 2`)
      return { stopped: true, reason: 'unsubscribed', emails_sent: 1 }
    }

    const sentGuidebook = await step.run('send-guidebook', async () => {
      try {
        const { error } = await resend.emails.send(
          {
            from:    DRIP_FROM,
            to:      email,
            replyTo: 'stephen@fieldstay.app',
            subject: 'The Guidebook That Knows What Time It Is',
            headers: audience72h.headers,
            html:    await renderGuidebookFeatureAnnouncementEmail({
              pmFirstName:    first_name,
              dashboardUrl:   `${APP_URL}/guidebook`,
              launchDate:     'now',
              unsubscribeUrl: audience72h.unsubscribeUrl ?? undefined,
              postalAddress:  commercialPostalAddress(),
            }),
          },
          { idempotencyKey: `onboarding-guidebook-${org_id}` }
        )
        if (error) {
          reportSendFailure(logger, 'Guidebook', org_id, error)
          return false
        }
        logger.info(`[Drip:${org_id}] Email 2 (Guidebook) sent`)
        return true
      } catch (err) {
        reportSendFailure(logger, 'Guidebook', org_id, err)
        return false
      }
    })

    // ── Wait 96 more hours (168h / 7 days total) ──────────────────────
    await step.sleep('wait-96h', '96h')

    // ── Email 3: Behavioral split on PMS connection ────────────────────
    const audience168h = await step.run('check-suppression-168h', async () => {
      const supabase = createServiceClient({ system: 'inngest:onboarding-drip' })
      return resolveEmailAudience(supabase, user_id)
    })

    if (audience168h.suppressed) {
      logger.info(`[Drip:${org_id}] User unsubscribed — sequence complete`)
      return { stopped: true, reason: 'unsubscribed', emails_sent: 2 }
    }

    const isConnected = await step.run('check-pms-connection', async () => {
      const supabase = createServiceClient({ system: 'inngest:onboarding-drip' })
      // A failed read reads as "no integrations connected", which sends the
      // drip email nudging a PM to connect one they already have.
      const connectionsRes = await supabase
        .from('integration_connections')
        .select('provider_id')
        .eq('org_id', org_id)
        .eq('status', 'active')
        .limit(1)

      const connections = unwrapList(connectionsRes, {
        site: 'inngest.onboarding-drip.integrations', orgId: org_id,
      })
      return connections.length > 0
    })

    // The connected variant of email 3 states a number: "N came in this week
    // — RepuGuard already has draft responses ready for your approval." That N
    // was the literal `3`, hardcoded at the call site, so every connected PM
    // was told three reviews arrived and drafts were waiting no matter what
    // was actually in their account — a false factual claim in a commercial
    // email, and one the recipient disproves by clicking the CTA. Counted for
    // real now; the template renders honest zero-copy rather than the
    // reviews-arrived copy when the answer is none.
    //
    // head+count, so this ships no rows and cannot be truncated by max_rows.
    const reviewCount = isConnected
      ? await step.run('count-recent-reviews', async () => {
          const supabase = createServiceClient({ system: 'inngest:onboarding-drip' })
          const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
          const res = await supabase
            .from('reviews')
            .select('id', { count: 'exact', head: true })
            .eq('org_id', org_id)
            .gte('review_date', sinceIso)
          return unwrapCount(res, { site: 'inngest.onboarding-drip.review-count', orgId: org_id })
        })
      : 0

    const sentReengagement = await step.run('send-reengagement', async () => {
      try {
        const { error } = await resend.emails.send(
          {
            from:    DRIP_FROM,
            to:      email,
            replyTo: 'stephen@fieldstay.app',
            subject: subjectForReengagement(isConnected, reviewCount),
            headers: audience168h.headers,
            html:    await renderReengagementEmail({
              firstName:       first_name,
              orgName:         org_name,
              isConnected,
              dashboardUrl:    `${APP_URL}/ops`,
              integrationsUrl: `${APP_URL}/settings?tab=integrations`,
              onboardingUrl:   `${APP_URL}/onboarding`,
              reviewCount,
              unsubscribeUrl:  audience168h.unsubscribeUrl ?? undefined,
              postalAddress:   commercialPostalAddress(),
            }),
          },
          { idempotencyKey: `onboarding-reengagement-${org_id}` }
        )
        if (error) {
          reportSendFailure(logger, 'Reengagement', org_id, error)
          return false
        }
        logger.info(`[Drip:${org_id}] Email 3 (Re-engagement, connected=${isConnected}) sent`)
        return true
      } catch (err) {
        reportSendFailure(logger, 'Reengagement', org_id, err)
        return false
      }
    })

    // Counted, not assumed: this used to hardcode 3 even when every send had
    // failed, so the run output said the sequence completed no matter what.
    const emailsSent = [sentWelcome, sentGuidebook, sentReengagement].filter(Boolean).length

    return { org_id, emails_sent: emailsSent, variant: isConnected ? 'connected' : 'not_connected' }
  }
)
