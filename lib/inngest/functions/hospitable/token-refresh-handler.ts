// lib/inngest/functions/hospitable/token-refresh-handler.ts
// ============================================================
// DEPRECATED — paired with the deprecated hospTokenRefreshCron above.
// See lib/inngest/functions/cron/integration-token-refresh-handler.ts for
// the unified replacement, which also marks the connection revoked and
// emails the PM on terminal failure (this handler does neither). Slated
// for removal in a follow-up along with the cron.
//
// Handles a single Hospitable token refresh, triggered by the weekly cron.
// Running per-user in isolation means one failure never blocks others.
// ============================================================

import { inngest }                from '@/lib/inngest/client'
import { refreshHospitableToken } from '@/lib/integrations/providers/hospitable-token'

export const hospTokenRefreshHandler = inngest.createFunction(
  {
    id:      'hospitable-token-refresh-handler',
    name:    'Hospitable: Token Refresh Handler',
    retries: 2,
    // One concurrent refresh per user — prevents race if cron and manual
    // trigger overlap for the same user
    concurrency: { limit: 1, key: 'event.data.user_id' },
  },
  { event: 'integration/hospitable.token.refresh.requested' as const },
  async ({ event, step, logger }) => {
    const { user_id, external_user_id } = event.data

    await step.run('refresh-token', async () => {
      // refreshHospitableToken requires externalUserId to avoid overwriting
      // the stored Hospitable account UUID in the connection row UPSERT
      await refreshHospitableToken(user_id, external_user_id ?? '')
    })

    logger.info(`[Hospitable refresh] Token refreshed for user ${user_id}`)
    return { user_id, refreshed: true }
  }
)
