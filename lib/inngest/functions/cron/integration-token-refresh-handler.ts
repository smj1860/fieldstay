// lib/inngest/functions/cron/integration-token-refresh-handler.ts
// Handles a single proactive token refresh, triggered by
// integrationTokenRefreshCron. Isolated per connection so one failure
// never blocks the others.
//
// On terminal failure (refresh token revoked/expired) the connection is
// marked 'revoked' and the PM gets one reconnect email, deduped via
// reconnect_email_sent_at — cleared automatically the next time
// store_integration_token succeeds (see the proactive_token_refresh migration).

import { inngest }                      from '@/lib/inngest/client'
import { createServiceClient }          from '@/lib/supabase/server'
import { NonRetriableError }            from 'inngest'
import { resend, FROM }                 from '@/lib/resend/client'
import { renderIntegrationErrorEmail }  from '@/lib/resend/emails/integration-error'
import { getPmEmails }                  from '@/lib/inngest/helpers'
import { refreshHospitableToken }       from '@/lib/integrations/providers/hospitable-token'
import { refreshKrogerToken }           from '@/lib/integrations/providers/kroger-token'

const PROVIDER_LABELS: Record<string, string> = {
  hospitable: 'Hospitable',
  kroger:     'Kroger',
}

export const integrationTokenRefreshHandler = inngest.createFunction(
  {
    id:      'integration-token-refresh-handler',
    name:    'Integration: Token Refresh Handler',
    retries: 2,
    // Inngest evaluates concurrency keys as expressions, not template
    // literals — dot/concat notation only. A backtick string here would
    // be used as one literal key, serializing every refresh globally.
    concurrency: {
      limit: 1,
      key:   'event.data.user_id + ":" + event.data.provider_id',
    },
  },
  { event: 'integration/token.proactive.refresh.requested' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id, provider_id, external_user_id } = event.data

    // ── Step 1: Attempt the refresh ────────────────────────────────────
    let refreshFailed  = false
    let isTerminalFail = false

    try {
      await step.run('refresh-token', async () => {
        if (provider_id === 'hospitable') {
          await refreshHospitableToken(user_id, external_user_id ?? '')
          return
        }

        if (provider_id === 'kroger') {
          await refreshKrogerToken(user_id)
          return
        }

        throw new NonRetriableError(
          `[TokenRefresh] No refresh implementation for provider: ${provider_id}`
        )
      })
    } catch (err: unknown) {
      refreshFailed = true

      isTerminalFail =
        err instanceof NonRetriableError ||
        (err instanceof Error &&
          (err.message.includes('400') || err.message.includes('401')))

      if (!isTerminalFail) {
        // Network/5xx — re-throw so Inngest retries with backoff
        throw err
      }

      logger.warn(
        `[TokenRefresh] Terminal refresh failure for ${provider_id}:${user_id} — ` +
        `marking revoked and notifying PM`
      )
    }

    if (!refreshFailed) {
      logger.info(`[TokenRefresh] ${provider_id} token refreshed for user ${user_id}`)
      return { user_id, provider_id, refreshed: true }
    }

    // ── Step 2: Mark revoked, check dedup (top-level, atomic UPDATE+RETURNING) ──
    const alreadyNotified = await step.run('mark-revoked', async () => {
      const supabase = createServiceClient()

      const { data: updatedConn } = await supabase
        .from('integration_connections')
        .update({ status: 'revoked', updated_at: new Date().toISOString() })
        .eq('user_id',    user_id)
        .eq('provider_id', provider_id)
        .select('reconnect_email_sent_at')
        .maybeSingle()

      return !!updatedConn?.reconnect_email_sent_at
    })

    // ── Step 3: Send the reconnect email, once (top-level) ─────────────
    if (!alreadyNotified) {
      await step.run('send-reconnect-email', async () => {
        const providerLabel = PROVIDER_LABELS[provider_id] ?? provider_id

        if (!org_id) {
          logger.warn(`[TokenRefresh] No org_id for ${provider_id}:${user_id} — cannot resolve PM email`)
          return
        }

        const supabase = createServiceClient()
        const [pmEmail] = await getPmEmails(supabase, org_id)

        if (!pmEmail) {
          logger.warn(`[TokenRefresh] No PM email found for org ${org_id} — cannot send reconnect notification`)
          return
        }

        const appUrl = process.env.NEXT_PUBLIC_APP_URL!
        const html   = await renderIntegrationErrorEmail({
          providerName: providerLabel,
          reason:
            `Your ${providerLabel} connection needs to be renewed. This happens ` +
            `periodically for security reasons and takes about 30 seconds to fix.`,
          reconnectUrl: `${appUrl}/settings/integrations`,
        })

        const { error: emailErr } = await resend.emails.send({
          from:    FROM,
          to:      pmEmail,
          replyTo: 'support@fieldstay.app',
          subject: `Action required — reconnect your ${providerLabel} account`,
          html,
        })

        if (emailErr) {
          logger.error(
            `[TokenRefresh] Reconnect email send failed for org ${org_id}: ${JSON.stringify(emailErr)}`
          )
          // Non-fatal — the connection is already marked revoked and the
          // PM will see the error state in the UI even without the email.
          return
        }

        await supabase
          .from('integration_connections')
          .update({ reconnect_email_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('user_id',    user_id)
          .eq('provider_id', provider_id)

        logger.info(`[TokenRefresh] Reconnect email sent to ${pmEmail} for ${providerLabel}`)
      })
    } else {
      logger.info(`[TokenRefresh] Reconnect email already sent for ${provider_id}:${user_id} — skipping`)
    }

    // Terminal — do not retry a refresh token that is already revoked.
    throw new NonRetriableError(
      `[TokenRefresh] Refresh token revoked for ${provider_id}:${user_id} — PM notified`
    )
  }
)
