// lib/inngest/functions/cron/integration-token-refresh.ts
// Unified proactive token refresh cron — runs every 2 hours.
// Covers all OAuth providers whose access tokens expire: Hospitable (12hr)
// and Kroger (30min). OwnerRez tokens never expire and are excluded.

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

const OAUTH_PROVIDERS = ['hospitable', 'kroger'] as const

export const integrationTokenRefreshCron = inngest.createFunction(
  {
    id:      'integration-token-refresh-cron',
    name:    'Integration: Proactive Token Refresh Cron',
    retries: 1,
    // Prevent overlapping runs if manually triggered while a scheduled run is active
    concurrency: { limit: 1, key: '"integration-token-refresh-cron"' },
  },
  { cron: '0 * * * *' },   // every hour at :00 (was every 2 hours — see windowEdge below)
  async ({ step, logger }) => {

    const connections = await step.run('fetch-expiring-connections', async () => {
      const supabase   = createServiceClient({ system: 'inngest:integration-token-refresh' })
      // Window (90min) is wider than the cron cadence (60min) so every
      // token gets caught by at least one run before it can expire — a
      // token landing just past a narrower window would otherwise expire
      // in the gap before the next tick. Previously 60min window on a
      // 120min cadence left up to a 60min expired-but-not-yet-refreshed
      // gap for Hospitable (12h token lifetime, no reactive refresh
      // fallback in readIntegrationToken()). Kroger is unaffected either
      // way — it refreshes reactively at call time regardless of this cron.
      const windowEdge = new Date(Date.now() + 90 * 60 * 1_000).toISOString()

      const { data, error } = await supabase
        .from('integration_connections')
        .select('user_id, org_id, provider_id, external_user_id, expires_at')
        .in('provider_id', OAUTH_PROVIDERS)
        .eq('status', 'active')
        .not('expires_at', 'is', null)
        .lte('expires_at', windowEdge)
        .not('refresh_token_vault_secret_id', 'is', null)

      if (error) throw new Error(`Token refresh cron: DB query failed: ${error.message}`)
      return data ?? []
    })

    logger.info(
      `[TokenRefreshCron] Found ${connections.length} connections expiring within 90 min`
    )

    if (connections.length === 0) return { dispatched: 0 }

    await step.sendEvent(
      'dispatch-refresh-events',
      connections.map((c) => ({
        name: 'integration/token.proactive.refresh.requested' as const,
        data: {
          user_id:          c.user_id,
          org_id:           c.org_id           ?? null,
          provider_id:      c.provider_id,
          external_user_id: c.external_user_id ?? '',
        },
      }))
    )

    return { dispatched: connections.length }
  }
)
