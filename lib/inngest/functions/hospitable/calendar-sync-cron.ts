// lib/inngest/functions/hospitable/calendar-sync-cron.ts
// ============================================================
// Daily cron — dispatches one calendar-block sync event per active
// Hospitable-sourced property. Hospitable's /reservations endpoint never
// represents a manually-blocked date range (confirmed 2026-07-10 — a real
// block only ever shows up in GET /properties/{uuid}/calendar), so there's
// no webhook to react to here; a lightweight daily poll is the only way to
// pick up a block a PM adds or removes in Hospitable directly. Same
// dispatch-per-unit pattern as hospTeammateSyncCron, one event per property
// instead of per connection since the calendar endpoint is per-property.
//
// Schedule: daily at 09:30 UTC — between the 09:00 teammate cron and the
// 13:00/14:00 UTC cron cluster.
// ============================================================

import { inngest }               from '@/lib/inngest/client'
import { fetchAllRows, fetchDistinctOrgIds } from '@/lib/inngest/paginate'
import { createServiceClient }   from '@/lib/supabase/server'
import { getPmMembersByOrgIds }  from '@/lib/inngest/helpers'

export const hospCalendarSyncCron = inngest.createFunction(
  {
    id:      'hospitable-calendar-sync-cron',
    name:    'Hospitable: Daily Calendar Block Sync Cron',
    retries: 1,
    concurrency: { limit: 1, key: '"hospitable-calendar-sync-cron"' },
  },
  { cron: '30 9 * * *' },
  async ({ step, logger }) => {

    // Orgs whose Hospitable connection is still active. Disconnecting an
    // integration (settings/integrations/actions.ts:disconnectIntegration)
    // only flips integration_connections.status and clears the Vault
    // secret — it never touches `properties`, so external_source/is_active
    // stay set on rows synced before the disconnect. Without this join,
    // this cron re-dispatches a doomed sync for those properties forever:
    // every run after a disconnect hits calendar-sync-handler, which
    // throws "No active connection ... Reconnect required" and exhausts
    // retries (see SENTRY-CRAZY-CUSHION-8).
    const activeOrgIds = await step.run('fetch-active-hospitable-org-ids', async () => {
      const supabase = createServiceClient({ system: 'inngest:calendar-sync-cron' })

      // Paginated for the same reason the property read below is: this is a
      // PLATFORM-WIDE scan of every active Hospitable connection, not one
      // tenant's. At max_rows = 1000 it would return the first 1000 with a
      // 200 and no truncation signal, and every org past that simply stops
      // having its calendar synced — with the cron still reporting success.
      //
      // Returns a plain array: step.run's return value is JSON-serialized by
      // Inngest, so a Set would come back empty.
      return await fetchDistinctOrgIds(
        (from, to) => supabase
          .from('integration_connections')
          .select('org_id')
          .eq('provider_id', 'hospitable')
          .eq('status', 'active')
          .not('org_id', 'is', null)
          .order('org_id')
          .range(from, to),
        { label: 'hospitable-calendar-sync-cron.connections' },
      )
    })

    if (activeOrgIds.length === 0) return { dispatched: 0, skipped_reason: 'no_active_connections' }

    const properties = await step.run('fetch-active-hospitable-properties', async () => {
      const supabase = createServiceClient({ system: 'inngest:calendar-sync-cron' })

      // Paginated: a multi-tenant fan-in (.in('org_id', activeOrgIds) is every
      // org with a live Hospitable connection, not one tenant), so the property
      // count grows with the platform. Truncation silently drops whole
      // properties out of calendar sync.
      return await fetchAllRows<{ id: string; org_id: string; external_id: string | null }>(
        (from, to) => supabase
          .from('properties')
          .select('id, org_id, external_id')
          .eq('external_source', 'hospitable')
          .eq('is_active', true)
          .not('external_id', 'is', null)
          // Listings Hospitable has stopped recognising. Without this the cron
          // re-dispatches a guaranteed 404 every morning forever — which it did
          // for one org from 2026-08-22 (SENTRY-CRAZY-CUSHION-F), exhausting
          // retries into Sentry each time with nothing able to resolve it. The
          // marker is cleared automatically the moment a sync lists the
          // property again, so this pause self-heals.
          .is('external_missing_since', null)
          .in('org_id', activeOrgIds)
          .order('id')
          .range(from, to),
        { label: 'hospitable-calendar-sync-cron.properties' },
      )
    })

    if (properties.length === 0) return { dispatched: 0 }

    const adminUserIdByOrg = await step.run('resolve-admins-by-org', async () => {
      const supabase = createServiceClient({ system: 'inngest:calendar-sync-cron' })
      const orgIds   = Array.from(new Set(properties.map((p) => p.org_id)))

      // getPmMembersByOrgIds is the single source of truth for "who is the PM"
      // (CLAUDE.md): it owns the invite_accepted_at filter and the
      // owner → admin → manager ordering. The open-coded query that used to
      // live here re-derived both, which is the drift that shipped as a live
      // crew/PM lockout three times. It is already the batched many-orgs form,
      // so this stays one query for every org; `limit: 1` reproduces the
      // owner-preferred single pick the manual loop made.
      const pmByOrg = await getPmMembersByOrgIds(supabase, orgIds, {
        roles: ['owner', 'admin'],
        limit: 1,
      })

      const result: Record<string, string> = {}
      for (const [orgId, members] of pmByOrg) {
        const primary = members[0]
        if (primary) result[orgId] = primary.userId
      }

      return result
    })

    const dispatchable = properties.filter((p) => adminUserIdByOrg[p.org_id])

    logger.info(
      `[Hospitable calendar-sync cron] Dispatching for ${dispatchable.length}/${properties.length} properties`
    )

    if (dispatchable.length === 0) return { dispatched: 0 }

    await step.sendEvent(
      'dispatch-calendar-sync-events',
      dispatchable.map((p) => ({
        name: 'integration/hospitable.calendar_sync.requested' as const,
        data: {
          property_id:            p.id,
          org_id:                 p.org_id,
          user_id:                adminUserIdByOrg[p.org_id]!,
          hospitable_property_id: p.external_id!,
        },
      }))
    )

    return { dispatched: dispatchable.length }
  }
)
