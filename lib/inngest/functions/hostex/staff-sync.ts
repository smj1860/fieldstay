// lib/inngest/functions/hostex/staff-sync.ts
// ============================================================================
// Hostex staff → crew_members.
//
// Two callers: the initial-sync on connect, and the daily reconcile. Hostex
// has no staff webhook, so the daily pass is how a hire or a departure ever
// arrives.
//
// WHY THIS FETCHES TASKS TOO. Hostex staff carry NO ROLE — not on /staffs, not
// on the create endpoint. Its docs call them "cleaners / operators /
// receptionists"; its schema gives nothing to tell them apart. The only
// evidence the API offers is what each person is actually assigned, so the
// task list is read purely to infer that. See inferHostexStaffRole.
//
// NOBODY IS AUTO-INVITED. Reception and room-service staff land in
// crew_members with role 'general' and a specialty naming what they do, not as
// organization_members — creating one of those means writing an org_invite and
// SENDING A REAL EMAIL to a real person as a side effect of a background sync.
// The PM promotes them deliberately through the existing invite flow.
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest }            from '@/lib/inngest/client'
import { fetchAllRows }       from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError }        from '@/lib/observability/report-error'
import { logAuditEvents }     from '@/lib/audit'
import {
  hostexFetchStaffs,
  hostexFetchTasks,
  hostexTaskWindow,
} from '@/lib/integrations/providers/hostex-api'
import { hostexStaffToCrewRows } from '@/lib/integrations/providers/hostex.mappers'
import type { HostexTask } from '@/lib/integrations/providers/hostex.types'
import type { SyncLogger } from '../shared/reservation-pipeline'

const PROVIDER = 'hostex'

/**
 * How far back to read tasks when inferring roles. Wide enough that a cleaner
 * who was off last week still reads as a cleaner, narrow enough that a role
 * someone stopped doing months ago stops counting.
 */
const ROLE_INFERENCE_WINDOW_DAYS = 90

type SyncStep = GetStepTools<typeof inngest>

export interface HostexStaffSyncParams {
  step:   SyncStep
  logger: SyncLogger
  token:  string
  orgId:  string
  userId: string
  system: string
  /** Distinguishes this call's Inngest step ids from a sibling call's. */
  stepPrefix: string
}

export async function syncHostexStaff(
  params: HostexStaffSyncParams,
): Promise<{ crewCount: number; deactivated: number }> {
  const { step, logger, token, orgId, userId, system, stepPrefix } = params

  // ── 1. Fetch staff + the tasks that reveal their roles ───────────────────
  const { staffs, tasks } = await step.run(`${stepPrefix}-fetch-staff`, async () => {
    const fetchedStaffs = await hostexFetchStaffs(token, userId)

    // Skipped entirely when there is no one to classify — the task sweep is
    // only ever a means to a role, never an end in itself.
    const fetchedTasks: HostexTask[] = fetchedStaffs.length
      ? await hostexFetchTasks(token, userId, hostexTaskWindow(ROLE_INFERENCE_WINDOW_DAYS))
      : []

    return { staffs: fetchedStaffs, tasks: fetchedTasks }
  })

  logger.info(`[Hostex:${userId}] Fetched ${staffs.length} staff, ${tasks.length} tasks for role inference`)

  // ── 2. Upsert as crew members ────────────────────────────────────────────
  const crewCount = await step.run(`${stepPrefix}-upsert-crew`, async () => {
    if (!staffs.length) return 0

    const tasksByStaff = new Map<number, HostexTask[]>()
    for (const task of tasks) {
      if (task.staff_id === null || task.staff_id === undefined) continue
      const existing = tasksByStaff.get(task.staff_id)
      if (existing) existing.push(task)
      else tasksByStaff.set(task.staff_id, [task])
    }

    const rows = hostexStaffToCrewRows(orgId, staffs, tasksByStaff)
    if (!rows.length) return 0

    const supabase = createServiceClient({ system })

    const { error } = await supabase
      .from('crew_members')
      .upsert(rows, { onConflict: 'org_id,external_id,external_source', ignoreDuplicates: false })

    if (error) {
      logger.error(`[Hostex:${userId}] crew_members upsert failed: ${error.message}`)
      throw new Error(`Staff upsert failed: ${error.message}`)
    }

    return rows.length
  })

  // ── 3. Deactivate crew that Hostex no longer lists ───────────────────────
  const deactivated = await step.run(`${stepPrefix}-deactivate-removed-staff`, async () => {
    // EMPTY-SET GUARD, and it is the whole reason this step is written out
    // rather than inlined. On 2026-07-18 one org's entire Hospitable crew
    // roster was deactivated in a single microsecond because the fetch
    // returned [] on a non-ok response and the deactivation pass had no guard.
    // Reconcile-by-absence treats an empty fetch as "everyone is absent".
    //
    // Empty is implausible here — an account with a Hostex connection and zero
    // staff has nothing to reconcile anyway — so this is the 'empty-set-guard'
    // arm of unit/guardrails/absence-reconciliation.test.ts, not the
    // 'fetch-fails-loud' one.
    const supabase = createServiceClient({ system })
    const freshExternalIds = new Set(staffs.map((s) => String(s.id)))

    // Guarded on freshExternalIds, NOT on staffs.length, and the difference is
    // real: they diverge if every staff came back without a usable id. The set
    // is what the absence filter below actually consults, so it is what has to
    // be non-empty for "absent" to mean anything.
    if (!freshExternalIds.size) {
      reportError(new Error('Hostex staff sync produced zero staff ids'), {
        site:  'inngest.hostex-staff-sync.empty-result-guard',
        orgId,
      })
      return 0
    }

    const existingActive = await fetchAllRows<{ id: string; external_id: string | null }>(
      (from, to) => supabase
        .from('crew_members')
        .select('id, external_id')
        .eq('org_id', orgId)
        .eq('external_source', PROVIDER)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to),
      { label: `hostex-staff.existing-active[org=${orgId}]` },
    )

    const toDeactivate = existingActive.filter(
      (row) => row.external_id && !freshExternalIds.has(row.external_id),
    )
    if (!toDeactivate.length) return 0

    const { error } = await supabase
      .from('crew_members')
      .update({ is_active: false })
      .in('id', toDeactivate.map((row) => row.id))

    if (error) throw new Error(`Deactivating removed Hostex staff failed: ${error.message}`)

    // Batched, not one call per row — logAuditEvents exists for exactly this.
    await logAuditEvents(
      toDeactivate.map((row) => ({
        orgId,
        action:     'crew.member.deactivated' as const,
        targetType: 'crew_member',
        targetId:   row.id,
        metadata:   { reason: 'removed_from_hostex' },
      })),
    )

    return toDeactivate.length
  })

  if (deactivated > 0) {
    logger.info(`[Hostex:${userId}] Deactivated ${deactivated} crew member(s) no longer in Hostex`)
  }

  return { crewCount, deactivated }
}
