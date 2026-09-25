// lib/integrations/health.ts
// ============================================================
// Single normalized health surface for every integration mechanism.
//
// Status is otherwise scattered across three places that don't share a
// shape: integration_connections.status (OAuth/API-key connections),
// integration_connections.metadata.last_sync_status (free-form jsonb, set
// by each sync function), and ical_feeds.last_sync_status (a completely
// separate per-property mechanism for manually-pasted Airbnb/VRBO/Booking.com
// calendar URLs — not the same thing as an OAuth provider connection, but
// answers the same underlying question: "is this data source healthy?").
//
// org_milestones is deliberately NOT folded in here — it's a one-time
// onboarding/celebration flag mechanism (see app/(dashboard)/layout.tsx),
// not an ongoing health signal.
//
// getIntegrationHealth() below is the one place that turns all of that into
// a single consistent shape. Exposed via GET /api/integrations/health.
// ============================================================

import { createServiceClient } from '@/lib/supabase/server'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { unwrapJoin } from '@/lib/utils/supabase-joins'

export type HealthStatus = 'healthy' | 'never_synced' | 'needs_attention' | 'needs_reconnect'

export interface IntegrationHealthItem {
  kind:        'connection' | 'ical_feed'
  id:          string
  providerId:  string
  label:       string
  status:      HealthStatus
  lastSyncAt:  string | null
  detail:      string | null
  propertyId?: string
}

// Kroger has no ongoing sync concept (cart builds are per-request, not a
// recurring job), so it never gets a last_sync_status and will always read
// as 'never_synced' here — that's an accurate label (Kroger doesn't sync),
// not a bug; its actual per-cart-build outcome lives in org_milestones.
function connectionStatus(
  connectionStatus: string,
  syncStatus: unknown,
  lastSyncedAt: unknown
): HealthStatus {
  // Deliberate disconnect is not a health problem — treat it the same as
  // never having connected, not as something needing reconnection urgency.
  if (connectionStatus === 'disconnected') return 'never_synced'
  if (connectionStatus === 'revoked' || connectionStatus === 'error') return 'needs_reconnect'
  if (syncStatus == null && !lastSyncedAt) return 'never_synced'
  // Anything other than a clean 'success' — 'error', 'rate_limited', or any
  // future non-success value a sync function might write — needs attention.
  if (syncStatus !== 'success') return 'needs_attention'
  return 'healthy'
}

function connectionDetail(status: string, syncError: string | null): string | null {
  if (status === 'revoked' || status === 'error') return `Connection ${status} — reconnect required`
  if (status === 'disconnected') return null
  return syncError
}

function feedStatus(lastSyncStatus: string | null, lastSyncedAt: string | null): HealthStatus {
  if (lastSyncStatus === 'error') return 'needs_attention'
  if (!lastSyncedAt) return 'never_synced'
  if (lastSyncStatus === 'success') return 'healthy'
  return 'needs_attention'
}

/**
 * The ical_feeds row shape this module reads. Written out because the read is
 * drained through fetchAllRows, which is generic — unlike a bare `.select()`,
 * it cannot infer the row type from the select string.
 *
 * `properties` is a PostgREST embed, so it arrives as an object or an array
 * depending on the relationship the planner picks; unwrapJoin normalises it.
 */
export interface IcalFeedRow {
  id:                string
  property_id:       string
  name:              string
  source:            string | null
  last_synced_at:    string | null
  last_sync_status:  string | null
  last_sync_error:   string | null
  properties:        { name: string } | { name: string }[] | null
}

export async function getIntegrationHealth(orgId: string): Promise<IntegrationHealthItem[]> {
  const admin = createServiceClient({ system: 'lib/integrations/health' })

  const [connectionsRes, providers, feeds] = await Promise.all([
    admin
      .from('integration_connections')
      .select('id, provider_id, status, metadata, updated_at')
      .eq('org_id', orgId),
    // Small platform registry, but paginated so it cannot truncate: a missing
    // provider row here renders as a blank integration NAME in the health UI.
    fetchAllRows<{ id: string; display_name: string }>(
      (from, to) => admin
        .from('integration_providers')
        .select('id, display_name')
        .order('id')
        .range(from, to),
      { label: 'integrations.health.providers' },
    ),
    // Drained, not a bare `.select()`. One feed per property per listing
    // platform, so a portfolio syncing Airbnb + VRBO crosses PostgREST's
    // max_rows = 1000 at roughly 350-500 properties — and truncation here is
    // the worst possible failure for this particular function, whose entire
    // job is to tell a PM when a sync is broken: the feeds it drops render as
    // healthy by absence.
    //
    // `.order('id')` is load-bearing, not presentation. `.range()` is OFFSET
    // pagination, so the ordering must be TOTAL or two pages answer different
    // questions; `name` and `source` repeat heavily across a portfolio.
    fetchAllRows<IcalFeedRow>(
      (from, to) => admin
        .from('ical_feeds')
        .select('id, property_id, name, source, last_synced_at, last_sync_status, last_sync_error, properties ( name )')
        .eq('org_id', orgId)
        .eq('is_active', true)
        .order('id')
        .range(from, to),
      { label: `integrations.health.ical_feeds[org=${orgId}]` },
    ),
  ])

  // Both siblings' errors are surfaced rather than dropped. This function backs
  // the integration HEALTH panel — the one surface whose entire job is to tell
  // a PM when a sync is broken — so rendering a failed query as "no
  // connections, no feeds" is the worst possible failure mode here: it reports
  // perfect health precisely when the database cannot be reached.
  throwIfAnyQueryFailed(
    { site: 'lib.integrations.health', orgId },
    connectionsRes.error,
  )
  const connections = connectionsRes.data

  const providerNames = Object.fromEntries(providers.map((p) => [p.id, p.display_name]))

  const connectionItems: IntegrationHealthItem[] = (connections ?? []).map((c) => {
    const metadata      = (c.metadata ?? {}) as Record<string, unknown>
    const syncStatus    = metadata.last_sync_status
    const syncError     = typeof metadata.last_sync_error === 'string' ? metadata.last_sync_error : null
    const lastSyncedAt  = typeof metadata.last_synced_at === 'string' ? metadata.last_synced_at : null

    return {
      kind:       'connection',
      id:         c.id,
      providerId: c.provider_id,
      label:      providerNames[c.provider_id] ?? c.provider_id,
      status:     connectionStatus(c.status, syncStatus, lastSyncedAt),
      lastSyncAt: lastSyncedAt,
      detail:     connectionDetail(c.status, syncError),
    }
  })

  const feedItems: IntegrationHealthItem[] = (feeds ?? []).map((f) => {
    const property = unwrapJoin(f.properties)
    return {
      kind:        'ical_feed',
      id:          f.id,
      // ical_feeds.source is nullable; 'other' is the column's own default.
      providerId:  f.source ?? 'other',
      label:       `${property?.name ?? 'Unknown property'} — ${f.name}`,
      status:      feedStatus(f.last_sync_status, f.last_synced_at),
      lastSyncAt:  f.last_synced_at,
      detail:      f.last_sync_error,
      propertyId:  f.property_id,
    }
  })

  // Attention-needed items first, healthiest last.
  const rank: Record<HealthStatus, number> = {
    needs_reconnect: 0,
    needs_attention: 1,
    never_synced:    2,
    healthy:         3,
  }

  return [...connectionItems, ...feedItems].sort((a, b) => rank[a.status] - rank[b.status])
}
