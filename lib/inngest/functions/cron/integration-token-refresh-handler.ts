// lib/inngest/functions/cron/integration-token-refresh-handler.ts
// Handles a single proactive token refresh, triggered by
// integrationTokenRefreshCron. Isolated per connection so one failure
// never blocks the others.
//
// On terminal failure (refresh token revoked/expired) the connection is
// marked 'revoked' and the PM gets one reconnect email, deduped via
// reconnect_email_sent_at — cleared automatically the next time
// store_integration_token succeeds (see the proactive_token_refresh migration).

import { unwrap } from '@/lib/supabase/unwrap'
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

    // ── Step 2: Mark revoked and CLAIM the reconnect email in one statement ──
    const claimed = await step.run('mark-revoked', async () => {
      const supabase = createServiceClient({ system: 'inngest:integration-token-refresh-handler' })

      // The claim is now the same UPDATE that flips the status, gated on
      // `reconnect_email_sent_at IS NULL`. It used to be split: this statement
      // set the status and merely READ reconnect_email_sent_at, and the send
      // step wrote it afterwards — with a failure there logged and swallowed
      // as "non-fatal".
      //
      // That combination has no exit. The cron re-fires this handler for the
      // connection every day, the refresh fails again every day (the token is
      // revoked), and the read still finds NULL because the write that would
      // have set it failed — so the PM gets the same "action required" email
      // every single day until that one write happens to succeed. A dedup flag
      // written after the thing it deduplicates is not a dedup flag.
      //
      // Claim-before-send inverts that: at most one email per revocation, and
      // the send retries below rather than the claim.
      //
      // Safe against a genuine re-revocation because reconnecting clears the
      // flag — store_integration_token() sets reconnect_email_sent_at = NULL
      // (20260707170000_fix_store_integration_token_race.sql), so a connection
      // that is fixed and later breaks again matches this filter afresh.
      //
      // Discarding the error returned `false` — "not yet notified" — so a
      // failed claim sent the email anyway, and the revoked status may not have
      // been written either. Throw so Inngest retries the claim.
      const now = new Date().toISOString()
      const claimRes = await supabase
        .from('integration_connections')
        .update({ status: 'revoked', reconnect_email_sent_at: now, updated_at: now })
        .eq('user_id',    user_id)
        .eq('provider_id', provider_id)
        .is('reconnect_email_sent_at', null)
        .select('id')
        .maybeSingle()

      const updatedConn = unwrap(
        claimRes,
        { site: 'inngest.integration-token-refresh-handler.mark-revoked' },
      )

      return !!updatedConn
    })

    // ── Step 3: Send the reconnect email, once (top-level) ─────────────
    if (claimed) {
      await step.run('send-reconnect-email', async () => {
        const providerLabel = PROVIDER_LABELS[provider_id] ?? provider_id

        if (!org_id) {
          logger.warn(`[TokenRefresh] No org_id for ${provider_id}:${user_id} — cannot resolve PM email`)
          return
        }

        const supabase = createServiceClient({ system: 'inngest:integration-token-refresh-handler' })
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

        // Keyed on the connection, so the step retries below cannot turn one
        // revocation into several emails. Resend's idempotency window is 24h,
        // which covers the retries but deliberately not tomorrow's cron run —
        // the DB claim above is what makes this once-per-revocation, and the
        // key is only protecting the retry path.
        const { error: emailErr } = await resend.emails.send({
          from:    FROM,
          to:      pmEmail,
          replyTo: 'support@fieldstay.app',
          subject: `Action required — reconnect your ${providerLabel} account`,
          html,
        }, { idempotencyKey: `integration-reconnect-${provider_id}-${user_id}` })

        // THROW, where this used to log and return.
        //
        // The claim is taken before the send now, so swallowing a send failure
        // would mean the PM is never told at all — the previous code could
        // afford to shrug because tomorrow's run would try again (which was
        // also the bug: it tried again every day forever). Throwing spends the
        // function's remaining retries on the send, and a terminal failure
        // reaches the dead-letter handler instead of disappearing.
        if (emailErr) {
          throw new Error(
            `[TokenRefresh] Reconnect email send failed for org ${org_id}: ${JSON.stringify(emailErr)}`
          )
        }

        // Recipient address deliberately not logged — it is a PM's email, and
        // these lines land in Axiom. The connection identifies the run.
        logger.info(`[TokenRefresh] Reconnect email sent for ${provider_id}:${user_id} (${providerLabel})`)
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
