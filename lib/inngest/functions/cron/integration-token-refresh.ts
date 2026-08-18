// lib/inngest/functions/cron/integration-token-refresh.ts
// Unified proactive token refresh cron — runs every 2 hours.
// Covers all OAuth providers whose access tokens expire: Hospitable (12hr),
// Kroger (30min) and Hostex (7 days). OwnerRez tokens never expire and are
// excluded.
//
// A provider listed in OAUTH_PROVIDERS MUST have a refresh branch in
// integration-token-refresh-handler.ts. The handler's fallthrough throws
// NonRetriableError, which it classifies as a TERMINAL failure — so adding an
// id there without the implementation does not no-op, it marks every one of
// that provider's connections 'revoked' and emails each PM to reconnect.
//
// NON_REFRESHABLE_PROVIDERS turns that same fallthrough from a footgun into the
// mechanism. Hostaway issues a ~6-month Bearer token from a one-time Account ID
// + API Key exchange and has NO refresh grant — hostawayExchangeCredentials()
// discards the key, so nothing on our side can mint a new token. "Terminal
// failure, mark revoked, email the PM to reconnect" is not a fallback for that
// provider; it is the only correct outcome, and reaching it through the path
// that already owns the claim-before-send dedup is better than a second
// notification route that would have to reinvent it.
//
// Before this, Hostaway matched NEITHER filter below — not the provider list,
// and not `refresh_token_vault_secret_id IS NOT NULL` — so its token expired in
// total silence and the only thing that would notice was cron/watchdog.ts
// reporting a connection gone quiet.

import { inngest }             from '@/lib/inngest/client'
import { fetchAllRows }        from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'

const OAUTH_PROVIDERS = ['hospitable', 'kroger', 'hostex'] as const

/**
 * Providers whose access token expires and CANNOT be refreshed.
 *
 * Scanned with the same expiry window as the refreshable ones, deliberately.
 * A wider window would give the PM more warning — welcome, since replacing a
 * Hostaway key is a manual trip to their dashboard rather than something we can
 * do for them — but the handler marks the connection `revoked`, and doing that
 * days early would stop syncs that were still working fine. Advance warning
 * needs a notification that does not flip status; this is the accurate-at-
 * expiry version, and it is the difference between one email and none.
 */
const NON_REFRESHABLE_PROVIDERS = ['hostaway'] as const

interface ExpiringConnection {
  user_id:          string
  org_id:           string | null
  provider_id:      string
  external_user_id: string | null
  expires_at:       string | null
}

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

      // Paginated: this scan is platform-wide — every org's Hospitable and
      // Kroger connection whose access token expires inside the window, not
      // one tenant's. Truncating at max_rows would leave the connections
      // sorted past row 1000 unrefreshed, and Hospitable has no reactive
      // refresh fallback in readIntegrationToken(), so those orgs' syncs
      // simply start failing with an expired token and nothing logs why.
      // org_id is NULLABLE on integration_connections (a connection made
      // before an org existed), which is why the send below coalesces it.
      const refreshable = await fetchAllRows<ExpiringConnection>(
        (from, to) => supabase
          .from('integration_connections')
          .select('user_id, org_id, provider_id, external_user_id, expires_at')
          .in('provider_id', OAUTH_PROVIDERS)
          .eq('status', 'active')
          .not('expires_at', 'is', null)
          .lte('expires_at', windowEdge)
          .not('refresh_token_vault_secret_id', 'is', null)
          .order('id')
          .range(from, to),
        { label: 'integration-token-refresh.expiring-connections' },
      )

      // Second scan rather than one `.or()`: the two differ in the
      // refresh-token filter, and that filter is the whole point. Requiring a
      // refresh secret is right for a provider we can refresh — dispatching
      // without one would attempt a refresh that cannot work — and wrong for
      // one we cannot, where its ABSENCE is the normal state and the dispatch
      // exists to notify rather than to refresh. Folding them into one
      // predicate would have to drop the filter for both.
      const nonRefreshable = await fetchAllRows<ExpiringConnection>(
        (from, to) => supabase
          .from('integration_connections')
          .select('user_id, org_id, provider_id, external_user_id, expires_at')
          .in('provider_id', NON_REFRESHABLE_PROVIDERS)
          .eq('status', 'active')
          .not('expires_at', 'is', null)
          .lte('expires_at', windowEdge)
          .order('id')
          .range(from, to),
        { label: 'integration-token-refresh.expiring-unrefreshable-connections' },
      )

      return [...refreshable, ...nonRefreshable]
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
