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
  if (connectionStatus === 'revoked' || connectionStatus === 'error') return 'needs_reconnect'
  if (syncStatus == null && !lastSyncedAt) return 'never_synced'
  // Anything other than a clean 'success' — 'error', 'rate_limited', or any
  // future non-success value a sync function might write — needs attention.
  if (syncStatus !== 'success') return 'needs_attention'
  return 'healthy'
}

function feedStatus(lastSyncStatus: string | null, lastSyncedAt: string | null): HealthStatus {
  if (lastSyncStatus === 'error') return 'needs_attention'
  if (!lastSyncedAt) return 'never_synced'
  if (lastSyncStatus === 'success') return 'healthy'
  return 'needs_attention'
}

export async function getIntegrationHealth(orgId: string): Promise<IntegrationHealthItem[]> {
  const admin = createServiceClient()

  const [{ data: connections }, { data: providers }, { data: feeds }] = await Promise.all([
    admin
      .from('integration_connections')
      .select('id, provider_id, status, metadata, updated_at')
      .eq('org_id', orgId),
    admin
      .from('integration_providers')
      .select('id, display_name'),
    admin
      .from('ical_feeds')
      .select('id, property_id, name, source, last_synced_at, last_sync_status, last_sync_error, properties ( name )')
      .eq('org_id', orgId)
      .eq('is_active', true),
  ])

  const providerNames = Object.fromEntries((providers ?? []).map((p) => [p.id, p.display_name]))

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
      detail:     c.status === 'revoked' || c.status === 'error'
        ? `Connection ${c.status} — reconnect required`
        : syncError,
    }
  })

  const feedItems: IntegrationHealthItem[] = (feeds ?? []).map((f) => {
    const property = Array.isArray(f.properties) ? f.properties[0] : f.properties
    return {
      kind:        'ical_feed',
      id:          f.id,
      providerId:  f.source,
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
