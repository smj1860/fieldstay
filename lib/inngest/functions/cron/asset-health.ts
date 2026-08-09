import { throwIfAnyQueryFailed, unwrapList } from '@/lib/supabase/unwrap'
import type { TablesInsert } from '@/types/database'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { fetchAllRows, foldAllRows, fetchDistinctOrgIds } from '@/lib/inngest/paginate'
import {
  scoreAssets,
  persistScores,
  computeWeightNudge,
  type AssetRow,
  type AssetStandardRow,
  type RepairSummary,
  type NudgeRepairCounts,
  lifespanYears,
  isLateLifeRepair,
} from './asset-health-helpers'

/**
 * Repair history older than this contributes nothing meaningful to a current
 * health score, but the query that fed it had no date bound at all — so it
 * grew with ALL work-order history forever, on top of being silently capped
 * at PostgREST's 1000-row limit. Three years covers the useful signal
 * (repeat-repair frequency and last-serviced date) with a bounded working set.
 */
const REPAIR_HISTORY_WINDOW_DAYS = 1095

/** asset_type_standards is a fixed platform reference table (21 rows today). */
const ASSET_TYPE_STANDARDS_LIMIT = 200

/**
 * SCHEDULED: 12:30 UTC daily (staggered off the 13:00 UTC batch — see the
 * stagger note in maintenance-schedules.ts).
 *
 *  • 8.4 — daily asset health score recalculation
 *
 * DISPATCHER ONLY. Previously this one invocation selected every active
 * property_asset platform-wide (~45,000 rows at 150 tenants) in a single
 * unbounded `.select()`, which PostgREST caps at 1000 with no error — so ~98%
 * of assets simply stopped being rescored, and daily-wrapup / capital-planning
 * went on reading a frozen health_score. The same array was also returned as a
 * step output and therefore re-sent on every subsequent step, which would blow
 * Inngest's step-output size limit long before the truncation was noticed.
 *
 * Now: one `org/asset_health.requested` per org, handled by assetHealthOrg
 * below under its own concurrency cap. The Bayesian weight nudge stays here
 * because it is genuinely platform-level (it tunes asset_type_standards, which
 * are global), but is now both date-windowed and paginated.
 */
export const dailyAssetHealth = inngest.createFunction(
  {
    id:      'cron-asset-health',
    name:    'Cron: Asset Health Scoring',
    retries: 2,
  },
  { cron: '30 12 * * *' },
  async ({ step, logger }) => {
    const orgIds = await step.run('find-orgs-with-active-assets', async () => {
      const supabase = createServiceClient({ system: 'inngest:asset-health' })
      return fetchDistinctOrgIds(
        (from, to) => supabase
          .from('property_assets')
          .select('org_id')
          .eq('is_active', true)
          .order('org_id', { ascending: true })
          .range(from, to),
        { label: 'property_assets.org_id' }
      )
    })

    logger.info(`Asset health: dispatching ${orgIds.length} org(s)`)

    if (orgIds.length) {
      await step.sendEvent(
        'fan-out-asset-health',
        orgIds.map((orgId) => ({
          name: 'org/asset_health.requested' as const,
          data: { org_id: orgId },
        }))
      )
    }

    // ── Bayesian weight nudge: per-asset-type age vs. condition weight drift ──
    // Platform-level (asset_type_standards is global), so it stays in the
    // dispatcher rather than running redundantly once per org.
    await step.run('bayesian-weight-nudge', async () => {
      const supabase = createServiceClient({ system: 'inngest:asset-health' })
      const windowStart = new Date(Date.now() - REPAIR_HISTORY_WINDOW_DAYS * 86_400_000)
        .toISOString().split('T')[0]!

      type NudgeRow = {
        asset_id: string | null
        completed_date: string | null
        assets: { asset_type: string; installation_date: string | null }
              | { asset_type: string; installation_date: string | null }[]
              | null
      }

      // Standards FIRST, because the late-life test needs each type's lifespan
      // and that is what lets the scan below fold instead of accumulate.
      const standardsRes = await supabase
        .from('asset_type_standards')
        .select('asset_type, display_name, age_weight, condition_weight, lifespan_min_years, lifespan_max_years')
        // Fixed platform reference table (21 asset types today); the explicit
        // bound documents that and keeps it out of the unbounded-select class.
        .limit(ASSET_TYPE_STANDARDS_LIMIT)

      const currentStandards = unwrapList(
        standardsRes,
        { site: 'inngest.asset-health.scoring-weight-nudge.standards' },
      )

      const lifespanByType = new Map<string, number>(
        (currentStandards ?? []).map((std) => [std.asset_type as string, lifespanYears(std)])
      )

      // FOLDED, not accumulated. This scan is platform-wide over a
      // REPAIR_HISTORY_WINDOW_DAYS window of completed work orders, and it used
      // to materialise every one of them — each with a joined property_assets
      // row — to produce two integers per asset type. At fetchAllRows' 200k
      // ceiling it did not degrade, it threw, taking the whole nudge with it.
      // The accumulator is now 21 counters regardless of how many repairs the
      // platform did.
      //
      // actual_cost and estimated_cost are gone from the select: computeWeightNudge
      // never read them. Pulling a financial field platform-wide to discard it
      // is not free, and actual_cost is one CLAUDE.md bans from logs.
      const byType = await foldAllRows<NudgeRow, Map<string, NudgeRepairCounts>>(
        (from, to) => supabase
          .from('work_orders')
          .select('asset_id, completed_date, assets:property_assets!asset_id(asset_type, installation_date)')
          .not('asset_id', 'is', null)
          .eq('status', 'completed')
          .gte('completed_date', windowStart)
          .order('id', { ascending: true })
          .range(from, to),
        new Map<string, NudgeRepairCounts>(),
        (acc, page) => {
          for (const wo of page) {
            const assetInfo = unwrapJoin(wo.assets)
            if (!assetInfo?.asset_type || !assetInfo.installation_date || !wo.completed_date) continue

            // A repair whose asset type has no standard row was collected and
            // then dropped at `if (!std) continue` below; dropping it here is
            // the same outcome one pass earlier. It does change
            // `asset_types_with_data`, which now counts only types that could
            // actually have been nudged.
            const lifespan = lifespanByType.get(assetInfo.asset_type)
            if (lifespan === undefined) continue

            const installYear = new Date(assetInfo.installation_date).getFullYear()
            const repairYear  = new Date(wo.completed_date).getFullYear()
            const ageAtRepair = Math.max(0, repairYear - installYear)

            const summary = acc.get(assetInfo.asset_type) ?? { total: 0, lateLife: 0 }
            summary.total++
            if (isLateLifeRepair(ageAtRepair, lifespan)) summary.lateLife++
            acc.set(assetInfo.asset_type, summary)
          }
          return acc
        },
        { label: 'work_orders(weight-nudge)' }
      )

      if (!byType.size) return { nudged: 0 }

      // .upsert() is an INSERT ... ON CONFLICT DO UPDATE, so the payload has
      // to be a row Postgres could actually insert — display_name and the two
      // lifespan columns are NOT NULL. They only ever round-trip the value
      // already on the row (every update is guarded by `if (!std) continue`),
      // but omitting them would make the insert arm of this statement invalid.
      const updates: TablesInsert<'asset_type_standards'>[] = []
      const oldWeightsByType: Record<string, { age_weight: number; condition_weight: number }> = {}

      for (const [assetType, repairs] of byType) {
        const std = currentStandards?.find((s) => s.asset_type === assetType)
        if (!std) continue

        const nudge = computeWeightNudge(repairs, std)
        if (!nudge) continue

        updates.push({
          asset_type:         std.asset_type,
          display_name:       std.display_name,
          lifespan_min_years: std.lifespan_min_years,
          lifespan_max_years: std.lifespan_max_years,
          ...nudge,
          weight_updated_at:  new Date().toISOString(),
        })
        oldWeightsByType[assetType] = {
          age_weight:       std.age_weight,
          condition_weight: std.condition_weight,
        }
      }

      if (updates.length) {
        const { error: upsertError } = await supabase
          .from('asset_type_standards')
          .upsert(updates, { onConflict: 'asset_type' })

        if (upsertError) {
          throwIfAnyQueryFailed(
            { site: 'inngest.asset-health.scoring-weight-nudge.upsert' },
            upsertError
          )
        }

        // Platform-level event — no org_id, orgId intentionally omitted
        await logAuditEvents(
          updates.map((u) => ({
            action:     'asset.scoring_weights.auto_adjusted' as const,
            targetType: 'asset_type_standard',
            targetId:   u.asset_type,
            metadata:   {
              old_age_weight:       oldWeightsByType[u.asset_type]?.age_weight,
              new_age_weight:       u.age_weight,
              old_condition_weight: oldWeightsByType[u.asset_type]?.condition_weight,
              new_condition_weight: u.condition_weight,
            },
          }))
        )
      }

      return { nudged: updates.length, asset_types_with_data: byType.size }
    })

    // COI & license expiry escalation (formerly 8.13) was removed — fully
    // superseded by cron-daily-wrapup's compliance digest section, which
    // re-queries vendor_compliance_documents independently with its own
    // 30-day lookahead window.

    return { dispatched: orgIds.length }
  }
)

/**
 * Per-org asset health scoring. One invocation = one tenant, so the asset list
 * is bounded by that tenant's asset count (and paginated regardless), the
 * repair-history query is scoped to that tenant's assets AND a 3-year window,
 * and a failing tenant retries only itself.
 */
export const assetHealthOrg = inngest.createFunction(
  {
    id:          'asset-health-org',
    name:        'Asset Health Scoring — per org',
    retries:     2,
    concurrency: { limit: 10 },
  },
  { event: 'org/asset_health.requested' },
  async ({ event, step, logger }) => {
    const orgId = event.data.org_id

    const scored = await step.run('score-and-persist-org-assets', async () => {
      const supabase = createServiceClient({ system: 'inngest:asset-health' })

      const activeAssets = await fetchAllRows<AssetRow>(
        (from, to) => supabase
          .from('property_assets')
          .select(`
            id, org_id, property_id, asset_type,
            installation_date, expected_lifespan_years,
            estimated_replacement_cost, health_score
          `)
          .eq('org_id', orgId)
          .eq('is_active', true)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `property_assets[org=${orgId}]` }
      )

      if (!activeAssets.length) return 0

      const standards = unwrapList(
        await supabase
          .from('asset_type_standards')
          .select('asset_type, lifespan_min_years, lifespan_max_years, avg_replacement_cost_high, age_weight, condition_weight')
          .limit(ASSET_TYPE_STANDARDS_LIMIT),
        { site: 'inngest.asset-health.score-org.standards', orgId },
      )

      const windowStart = new Date(Date.now() - REPAIR_HISTORY_WINDOW_DAYS * 86_400_000)
        .toISOString().split('T')[0]!

      const repairWOs = await fetchAllRows<{
        asset_id: string | null
        actual_cost: number | null
        estimated_cost: number | null
        completed_date: string | null
      }>(
        (from, to) => supabase
          .from('work_orders')
          .select('asset_id, actual_cost, estimated_cost, completed_date')
          .eq('org_id', orgId)
          .not('asset_id', 'is', null)
          .eq('status', 'completed')
          .gte('completed_date', windowStart)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `work_orders(repair-history)[org=${orgId}]` }
      )

      const repairByAsset: Record<string, RepairSummary> = {}
      for (const wo of repairWOs) {
        if (!wo.asset_id) continue
        const r = repairByAsset[wo.asset_id]
        if (!r) {
          repairByAsset[wo.asset_id] = {
            total_repairs:     1,
            total_repair_cost: wo.actual_cost ?? wo.estimated_cost ?? 0,
            last_serviced_at:  wo.completed_date ?? null,
          }
        } else {
          r.total_repairs++
          r.total_repair_cost += wo.actual_cost ?? wo.estimated_cost ?? 0
          if (wo.completed_date && (!r.last_serviced_at || wo.completed_date > r.last_serviced_at)) {
            r.last_serviced_at = wo.completed_date
          }
        }
      }

      const { updates } = scoreAssets(
        activeAssets,
        (standards ?? []) as AssetStandardRow[],
        repairByAsset,
        new Date().toISOString(),
      )

      // A pure UPDATE keyed on id and scoped to this org — idempotent, so a
      // step retry simply rewrites the same scores.
      const persisted = await persistScores(supabase, orgId, updates)

      // A shortfall means assets disappeared between the read and the write.
      // Benign on its own, but silence here is what let a total write failure
      // look like a healthy run for sixteen days.
      if (persisted !== updates.length) {
        logger.warn(
          `[asset-health] org ${orgId}: attempted ${updates.length} score update(s), ` +
          `${persisted} row(s) matched — assets likely removed mid-run`
        )
      }

      return persisted
    })

    logger.info(`Asset health: scored ${scored} asset(s) for org ${orgId}`)
    return { org_id: orgId, assets_scored: scored }
  }
)
