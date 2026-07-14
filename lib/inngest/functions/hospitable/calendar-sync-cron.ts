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

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

export const hospCalendarSyncCron = inngest.createFunction(
  {
    id:      'hospitable-calendar-sync-cron',
    name:    'Hospitable: Daily Calendar Block Sync Cron',
    retries: 1,
    concurrency: { limit: 1, key: '"hospitable-calendar-sync-cron"' },
  },
  { cron: '30 9 * * *' },
  async ({ step, logger }) => {

    const properties = await step.run('fetch-active-hospitable-properties', async () => {
      const supabase = createServiceClient()

      const { data, error } = await supabase
        .from('properties')
        .select('id, org_id, external_id')
        .eq('external_source', 'hospitable')
        .eq('is_active', true)
        .not('external_id', 'is', null)

      if (error) throw new Error(`Failed to fetch properties: ${error.message}`)
      return data ?? []
    })

    if (properties.length === 0) return { dispatched: 0 }

    const adminUserIdByOrg = await step.run('resolve-admins-by-org', async () => {
      const supabase = createServiceClient()
      const orgIds   = Array.from(new Set(properties.map((p) => p.org_id)))

      // One batched query for all orgs instead of one sequential query per org.
      const { data: members } = await supabase
        .from('organization_members')
        .select('org_id, user_id, role')
        .in('org_id', orgIds)
        .in('role', ['owner', 'admin'])
        .not('invite_accepted_at', 'is', null)

      const result: Record<string, string> = {}
      for (const member of members ?? []) {
        if (!result[member.org_id] || member.role === 'owner') {
          result[member.org_id] = member.user_id
        }
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
