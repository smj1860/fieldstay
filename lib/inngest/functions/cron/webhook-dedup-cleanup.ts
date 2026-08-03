import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * SCHEDULED: runs daily at 04:00 UTC (off-peak for US checkout windows).
 *
 * Replaces the webhook route's old probabilistic cleanup (5% of requests)
 * with a real cron — at one customer the 5% roll could go days without
 * firing, letting processed_webhooks accumulate past its 72h TTL; at a
 * hundred it fired far more often than the table needed, adding an RPC to
 * the hot webhook path on every 20th request.
 */
export const webhookDedupCleanup = inngest.createFunction(
  {
    id:          'webhook-dedup-cleanup',
    name:        'Webhooks: Dedup TTL Cleanup',
    retries:     1,
    concurrency: { limit: 1, key: '"webhook-dedup-cleanup"' },
  },
  { cron: '0 4 * * *' },   // 04:00 UTC daily — off-peak for US checkout windows
  async ({ step, logger }) => {
    await step.run('cleanup-webhook-dedup', async () => {
      const supabase = createServiceClient({ system: 'inngest:webhook-dedup-cleanup' })
      const { error } = await supabase.rpc('cleanup_webhook_dedup')
      if (error) throw new Error(`cleanup_webhook_dedup failed: ${error.message}`)
    })

    // oauth_states rides along here rather than getting its own cron: same
    // cadence, same off-peak slot, same "expire rows nobody will ever read
    // again" job. cleanup_expired_oauth_states() has existed in the database
    // since the integration framework shipped, but nothing has ever called it
    // — pg_cron is not installed on this project and no code referenced it —
    // so expires_at was written and then never acted on. Every abandoned OAuth
    // handshake has been accumulating since, on a table an unauthenticated
    // route can insert into.
    await step.run('cleanup-expired-oauth-states', async () => {
      const supabase = createServiceClient({ system: 'inngest:webhook-dedup-cleanup' })
      const { error } = await supabase.rpc('cleanup_expired_oauth_states')
      if (error) throw new Error(`cleanup_expired_oauth_states failed: ${error.message}`)
    })

    logger.info('[WebhookDedupCleanup] TTL sweep complete')
    return { ok: true }
  },
)
