// lib/inngest/functions/hospitable/token-refresh-cron.ts
// ============================================================
// DEPRECATED — superseded by integrationTokenRefreshCron
// (lib/inngest/functions/cron/integration-token-refresh.ts), which covers
// Hospitable and Kroger on a bi-hourly, expiry-aware schedule instead of
// this weekly blanket refresh. Kept running for one deploy cycle rather
// than removed outright; safe to leave in place in the meantime since a
// redundant refresh is a no-op. Slated for removal in a follow-up.
//
// Weekly cron — dispatches one refresh event per active Hospitable connection.
// Each connection is handled by hospTokenRefreshHandler in its own function
// invocation, avoiding unbounded step counts and scale limits.
//
// Schedule: every Monday at 08:00 UTC
// ============================================================

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

export const hospTokenRefreshCron = inngest.createFunction(
  {
    id:      'hospitable-token-refresh-cron',
    name:    'Hospitable: Weekly Token Refresh Cron',
    retries: 1,
    // Prevent overlapping runs if manually triggered while a scheduled run is active
    concurrency: { limit: 1, key: '"hospitable-token-refresh-cron"' },
  },
  { cron: '0 8 * * 1' },
  async ({ step, logger }) => {

    const connections = await step.run('fetch-active-connections', async () => {
      const supabase = createServiceClient()

      const { data, error } = await supabase
        .from('integration_connections')
        .select('user_id, org_id, external_user_id')
        .eq('provider_id', 'hospitable')
        .eq('status',      'active')
        .not('refresh_token_vault_secret_id', 'is', null)

      if (error) throw new Error(`Failed to fetch connections: ${error.message}`)

      return data ?? []
    })

    logger.info(`[Hospitable cron] Dispatching refresh for ${connections.length} connections`)

    if (connections.length === 0) {
      return { dispatched: 0 }
    }

    // Dispatch one event per connection — each runs in an isolated invocation.
    // No step-count limits, no sequential bottleneck, failures are isolated.
    await step.sendEvent(
      'dispatch-refresh-events',
      connections.map((c) => ({
        name: 'integration/hospitable.token.refresh.requested' as const,
        data: {
          user_id:          c.user_id,
          org_id:           c.org_id           ?? null,
          external_user_id: c.external_user_id ?? '',
        },
      }))
    )

    return { dispatched: connections.length }
  }
)
