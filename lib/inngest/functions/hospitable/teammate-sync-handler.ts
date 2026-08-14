// lib/inngest/functions/hospitable/teammate-sync-handler.ts
// ============================================================
// Triggered by: integration/hospitable.teammate_sync.requested
// Fired by:     hospTeammateSyncCron, once daily per active connection.
//
// Re-fetches the full teammate list and:
//  1. Upserts it — adds new teammates, updates changed fields, and
//     reactivates (is_active: true) anyone previously deactivated who's
//     back in the list.
//  2. Deactivates any crew_members row (external_source: 'hospitable',
//     this org) that's still active but no longer appears in the fresh
//     fetch — mirrors the soft-delete convention used by the manual
//     deactivateCrewMember() action and the 404-deactivation branch in
//     hospitable/incremental-sync.ts's property handler. A soft delete,
//     not a hard delete, so existing turnover_assignments/work_orders
//     FK references stay intact.
// ============================================================

import { inngest }                 from '@/lib/inngest/client'
import { createServiceClient }     from '@/lib/supabase/server'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { hospFetchTeammates, hospitableTeammatesToCrewRows } from '@/lib/integrations/providers/hospitable'
import { logAuditEvents } from '@/lib/audit'
import { reportError }    from '@/lib/observability/report-error'

const PROVIDER = 'hospitable'

export const hospTeammateSyncHandler = inngest.createFunction(
  {
    id:      'hospitable-teammate-sync-handler',
    name:    'Hospitable: Teammate Resync Handler',
    retries: 2,
    // Cron-fanned across every active connection — at 100 customers this
    // would otherwise burst 100-wide into the single shared
    // hospitableApiLimiter budget. Platform cap plus the existing per-org
    // limit, same shape as hospInitialSync's.
    concurrency: [
      { limit: 4 },
      { limit: 2, key: 'event.data.org_id' },
    ],
  },
  { event: 'integration/hospitable.teammate_sync.requested' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id } = event.data

    const token = await step.run('get-valid-token', async () => {
      return getValidHospitableToken(user_id)
    })

    const teammates = await step.run('fetch-teammates', async () => {
      return hospFetchTeammates(token)
    })

    const upsertCount = await step.run('upsert-teammates', async () => {
      const rows = hospitableTeammatesToCrewRows(org_id, teammates)
      if (!rows.length) return 0

      const supabase = createServiceClient({ system: 'inngest:teammate-sync-handler' })
      const { error } = await supabase
        .from('crew_members')
        .upsert(rows, { onConflict: 'org_id,external_id,external_source', ignoreDuplicates: false })

      if (error) throw new Error(`Teammates upsert failed: ${error.message}`)
      return rows.length
    })

    const deactivatedCount = await step.run('deactivate-removed-teammates', async () => {
      const supabase = createServiceClient({ system: 'inngest:teammate-sync-handler' })
      const freshExternalIds = new Set(teammates.map((t) => t.id))

      // An EMPTY fresh set is not "every teammate was removed upstream".
      //
      // This step reconciles by absence, which is the only way a removal is
      // ever detectable — but absence-as-signal has one degenerate input, and
      // hospFetchTeammates hands it to us readily: it returns [] on ANY non-ok
      // response, including the 403 its own doc comment names as expected for a
      // connection lacking the teammate:read scope. With an empty set every
      // active Hospitable crew member is absent, so this deactivated the org's
      // ENTIRE roster and wrote an audit row for each saying they were removed
      // from Hospitable.
      //
      // That is not hypothetical. In production on 2026-07-18 at 09:00 UTC all
      // three of one org's Hospitable crew members were deactivated at the same
      // microsecond — one batch, the whole roster, from a single cron run.
      //
      // The asymmetry decides it, exactly as in ownerrez/reconciliation-handler
      // and ical-sync: declining to deactivate leaves a stale crew row for one
      // more day, while deactivating wrongly removes real people from
      // scheduling and assignment.
      if (freshExternalIds.size === 0) {
        logger.error(
          `[Hospitable teammate-sync] org ${org_id}: ZERO teammates returned — ` +
          `skipping the deactivation pass rather than deactivating every crew member`
        )
        reportError(new Error('Hospitable teammate sync returned zero teammates'), {
          site:  'inngest.hospitable-teammate-sync-handler.empty-result-guard',
          orgId: org_id,
        })
        return 0
      }

      const { data: existingActive, error: fetchErr } = await supabase
        .from('crew_members')
        .select('id, external_id')
        .eq('org_id', org_id)
        .eq('external_source', PROVIDER)
        .eq('is_active', true)

      if (fetchErr) throw new Error(`Fetching existing crew members failed: ${fetchErr.message}`)

      const toDeactivate = (existingActive ?? []).filter(
        (row) => row.external_id && !freshExternalIds.has(row.external_id)
      )
      if (!toDeactivate.length) return 0

      const { error: updateErr } = await supabase
        .from('crew_members')
        .update({ is_active: false })
        .in('id', toDeactivate.map((row) => row.id))

      if (updateErr) throw new Error(`Deactivating removed teammates failed: ${updateErr.message}`)

      await logAuditEvents(
        toDeactivate.map((row) => ({
          orgId:      org_id,
          action:     'crew.member.deactivated' as const,
          targetType: 'crew_member',
          targetId:   row.id,
          metadata:   { reason: 'removed_from_hospitable' },
        }))
      )

      return toDeactivate.length
    })

    logger.info(
      `[Hospitable teammate-sync] org ${org_id}: ${upsertCount} upserted, ${deactivatedCount} deactivated`
    )

    return { upserted: upsertCount, deactivated: deactivatedCount }
  }
)
