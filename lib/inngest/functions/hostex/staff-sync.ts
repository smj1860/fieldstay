// lib/inngest/functions/hostex/staff-sync.ts
// ============================================================================
// Hostex staff → crew_members.
//
// Two callers: the initial-sync on connect, and the daily reconcile. Hostex
// has no staff webhook, so the daily pass is how a hire or a departure ever
// arrives.
//
// WHY THIS FETCHES TASKS TOO — for two things, from one request.
//
//   1. ROLES. Hostex staff carry NO ROLE — not on /staffs, not on the create
//      endpoint. Its docs call them "cleaners / operators / receptionists";
//      its schema gives nothing to tell them apart. What each person is
//      ASSIGNED is the only evidence the API offers. See inferHostexStaffRole.
//
//   2. CLEANING COST. A cleaning task's `fee` is the only per-property money
//      Hostex exposes anywhere — /properties has no fee field — so without it
//      every imported property keeps FieldStay's default cleaning_cost, which
//      then feeds owner P&L and turnover costing as a guess.
//
// Both are DERIVED INSIDE THE FETCH STEP and only the small maps are returned.
// Inngest persists each step's return value and re-sends it on every later
// step; 90 days of tasks for a real portfolio is megabytes, the two maps are
// hundreds of bytes.
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
import {
  hostexStaffToCrewRows,
  deriveHostexStaffRoles,
  deriveHostexCleaningFees,
} from '@/lib/integrations/providers/hostex.mappers'
import type { HostexCrewMemberRow } from '@/lib/integrations/providers/hostex.mappers'
import { unwrapList } from '@/lib/supabase/unwrap'
import type { SyncLogger } from '../shared/reservation-pipeline'

const PROVIDER = 'hostex'

/**
 * How far back to read tasks. Wide enough that a cleaner who was off last week
 * still reads as a cleaner and that a property has several cleans to take a
 * median fee from; narrow enough that a role someone stopped doing months ago,
 * or last year's pricing, stops counting.
 */
const TASK_WINDOW_DAYS = 90

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
  /**
   * Hostex property id → FieldStay properties.id. When supplied, cleaning
   * fees derived from the same task fetch are backfilled onto those
   * properties. Omit to sync staff only.
   */
  propertyIdMap?: Record<string, string>
}

/**
 * Replace each row's inferred role with the one already stored, wherever the
 * stored one is more specific than 'general'. See the call site for why the
 * role is treated differently from every other synced column.
 *
 * One read for the whole batch, keyed by external_id — never a lookup per
 * staff member (unit/guardrails/n-plus-one-loops.test.ts).
 */
async function preserveManualCrewRoles(
  supabase: ReturnType<typeof createServiceClient>,
  orgId:    string,
  rows:     HostexCrewMemberRow[],
): Promise<HostexCrewMemberRow[]> {
  const externalIds = rows.map((r) => r.external_id)

  const existingRes = await supabase
    .from('crew_members')
    .select('external_id, role')
    .eq('org_id', orgId)
    .eq('external_source', PROVIDER)
    .in('external_id', externalIds)
    // Bounded by the write being read back, so this can never be the thing
    // that truncates — same convention as upsert-normalized's re-select.
    .limit(externalIds.length)

  // A failed read must not silently fall through to overwriting every role:
  // that is the exact behaviour being fixed. unwrapList throws, and the
  // enclosing step retries.
  const existing = unwrapList(existingRes, {
    site:  'inngest.hostex-staff-sync.existing-roles',
    orgId,
  })

  const roleByExternalId = new Map(
    (existing ?? []).map((row) => [row.external_id as string, row.role as string]),
  )

  return rows.map((row) => {
    const stored = roleByExternalId.get(row.external_id)
    return stored && stored !== 'general' ? { ...row, role: stored as typeof row.role } : row
  })
}

export async function syncHostexStaff(
  params: HostexStaffSyncParams,
): Promise<{ crewCount: number; deactivated: number; pricedProperties: number }> {
  const { step, logger, token, orgId, userId, system, stepPrefix, propertyIdMap } = params

  const wantsFees = Boolean(propertyIdMap && Object.keys(propertyIdMap).length)

  // ── 1. Fetch staff + tasks, return only what they imply ──────────────────
  const { staffs, roles, cleaningFees } = await step.run(`${stepPrefix}-fetch-staff`, async () => {
    const fetchedStaffs = await hostexFetchStaffs(token, userId)

    // Skipped only when there is nothing either derivation could use.
    const needTasks = fetchedStaffs.length > 0 || wantsFees
    const tasks = needTasks
      ? await hostexFetchTasks(token, userId, hostexTaskWindow(TASK_WINDOW_DAYS))
      : []

    return {
      staffs:       fetchedStaffs,
      roles:        deriveHostexStaffRoles(tasks),
      cleaningFees: wantsFees ? deriveHostexCleaningFees(tasks) : {},
    }
  })

  logger.info(
    `[Hostex:${userId}] Fetched ${staffs.length} staff; ` +
    `roles for ${Object.keys(roles).length}, cleaning fees for ${Object.keys(cleaningFees).length} properties`
  )

  // ── 2. Upsert as crew members ────────────────────────────────────────────
  const crewCount = await step.run(`${stepPrefix}-upsert-crew`, async () => {
    if (!staffs.length) return 0

    const rows = hostexStaffToCrewRows(orgId, staffs, roles)
    if (!rows.length) return 0

    const supabase = createServiceClient({ system })

    // ROLE IS OURS, NOT HOSTEX'S — so it does not get overwritten like the
    // rest of the row does.
    //
    // Hostex staff records carry no role field at all; the role in `rows` is
    // INFERRED from each person's scheduled task types. This step runs on the
    // daily reconcile, so writing that inference unconditionally meant a PM
    // who corrected a receptionist from General to Cleaning got it reverted
    // the next morning, every morning. Name, email, phone and is_active are
    // still overwritten, and should be: those Hostex actually reports.
    //
    // Upgrade-only, rather than never-touch. A staff member with no tasks yet
    // lands on 'general', and the inference genuinely improves once they have
    // a history — freezing the first guess forever would be its own bug. So a
    // specific role already on the row always wins, and 'general' is treated
    // as "not yet known" and may be replaced. The one case this gets wrong is
    // a PM who deliberately chose General; they may see it change once, which
    // is a far smaller loss than every correction being erased nightly.
    const preserved = await preserveManualCrewRoles(supabase, orgId, rows)

    const { error } = await supabase
      .from('crew_members')
      .upsert(preserved, { onConflict: 'org_id,external_id,external_source', ignoreDuplicates: false })

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

  // ── 4. Backfill cleaning cost from the same task fetch ───────────────────
  const pricedProperties = await step.run(`${stepPrefix}-backfill-cleaning-cost`, async () => {
    const entries = Object.entries(cleaningFees)
      .map(([hostexPropertyId, fee]) => [propertyIdMap?.[hostexPropertyId], fee] as const)
      .filter((e): e is readonly [string, number] => Boolean(e[0]))

    if (!entries.length) return 0

    const supabase = createServiceClient({ system })

    // Grouped by fee so this is one UPDATE per distinct price rather than one
    // per property — a portfolio usually prices in a handful of tiers. The
    // per-property alternative is the shape n-plus-one-loops.test.ts exists to
    // catch, and the same grouping trick geocodeMissingCoordinates uses.
    const idsByFee = new Map<number, string[]>()
    for (const [propertyId, fee] of entries) {
      const ids = idsByFee.get(fee)
      if (ids) ids.push(propertyId)
      else idsByFee.set(fee, [propertyId])
    }

    let priced = 0
    for (const [fee, ids] of idsByFee) {
      // BACKFILL ONLY — `.is('cleaning_cost', null)` is load-bearing. A PM's
      // own cleaning_cost is what FieldStay actually pays a cleaner and can
      // legitimately differ from what Hostex bills; overwriting it every day
      // would silently replace their number with the provider's. Same
      // contract as backfillCleaningCost() in lib/properties/upsert-normalized.
      const { data, error } = await supabase
        .from('properties')
        .update({ cleaning_cost: fee })
        .in('id', ids)
        .is('cleaning_cost', null)
        .select('id')

      if (error) {
        // Non-fatal: a missing cleaning cost degrades an estimate, it does not
        // break the sync that just imported the crew.
        logger.error(`[Hostex:${userId}] cleaning_cost backfill failed: ${error.message}`)
        reportError(error, { site: 'inngest.hostex-staff-sync.backfill-cleaning-cost', orgId })
        continue
      }

      priced += (data ?? []).length
    }

    return priced
  })

  if (pricedProperties > 0) {
    logger.info(`[Hostex:${userId}] Backfilled cleaning cost on ${pricedProperties} property(ies)`)
  }

  return { crewCount, deactivated, pricedProperties }
}
