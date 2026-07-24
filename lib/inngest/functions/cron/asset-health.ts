import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import {
  scoreAssets,
  persistScores,
  computeWeightNudge,
  type RepairRecord,
} from './asset-health-helpers'

/**
 * SCHEDULED: runs every morning at 8am CT (independent of other maintenance crons).
 *
 *  • 8.4 — daily asset health score recalculation
 *
 * This keeps running daily, unchanged — cron-daily-wrapup's Friday-only
 * asset-health digest section reads property_assets.health_score, so it
 * needs fresh data every day even though it only surfaces to the PM
 * weekly. The PM-facing threshold-crossing alert email that used to live
 * here (and the COI/license expiry escalation, 8.13) were removed — both
 * are now covered by the daily wrap-up digest instead (sections 3 and 4).
 */
export const dailyAssetHealth = inngest.createFunction(
  {
    id:      'cron-asset-health',
    name:    'Cron: Asset Health Scoring',
    retries: 2,
  },
  { cron: '0 13 * * *' },
  async ({ step, logger }) => {
    // ── 8.4: Daily Asset Health Score Recalculation ──────────────────────────
    const activeAssets = await step.run('find-assets-for-scoring', async (): Promise<Array<{
      id: string
      org_id: string
      property_id: string
      asset_type: string
      installation_date: string | null
      expected_lifespan_years: number | null
      estimated_replacement_cost: number | null
      health_score: number | null
    }>> => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('property_assets')
        .select(`
          id, org_id, property_id, asset_type,
          installation_date, expected_lifespan_years,
          estimated_replacement_cost, health_score
        `)
        .eq('is_active', true)
      return data ?? []
    })

    logger.info(`Found ${activeAssets.length} active assets to score`)

    if (activeAssets.length > 0) {
      const standards = await step.run('fetch-asset-standards', async () => {
        const supabase = createServiceClient()
        const { data } = await supabase
          .from('asset_type_standards')
          .select('asset_type, lifespan_min_years, lifespan_max_years, avg_replacement_cost_high, age_weight, condition_weight')
        return data ?? []
      })

      const repairWOs = await step.run('fetch-asset-repair-history', async () => {
        const supabase = createServiceClient()
        const { data } = await supabase
          .from('work_orders')
          .select('asset_id, actual_cost, estimated_cost, completed_date')
          .not('asset_id', 'is', null)
          .eq('status', 'completed')
        return data ?? []
      })

      // Aggregate repair history per asset
      const repairByAsset: Record<string, {
        total_repairs: number
        total_repair_cost: number
        last_serviced_at: string | null
      }> = {}
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

      // Group assets by org for batched updates
      const assetsByOrg = activeAssets.reduce<Record<string, typeof activeAssets>>((acc, a) => {
        ;(acc[a.org_id] ??= []).push(a)
        return acc
      }, {})

      for (const [orgId, orgAssets] of Object.entries(assetsByOrg)) {
        // Scoring is pure — its own step so a retry of persist below
        // never re-runs the (cheap, deterministic) computation.
        const { updates } = await step.run(`score-org-assets-${orgId}`, async () => {
          const now = new Date().toISOString()
          return scoreAssets(orgAssets, standards, repairByAsset, now)
        })

        if (updates.length > 0) {
          await step.run(`persist-scores-${orgId}`, async () => {
            const supabase = createServiceClient()
            await persistScores(supabase, updates)
          })
        }
      }

      // ── Bayesian weight nudge: per-asset-type age vs. condition weight drift ──
      await step.run('bayesian-weight-nudge', async () => {
        const supabase = createServiceClient()

        const { data: assetRepairs } = await supabase
          .from('work_orders')
          .select('asset_id, actual_cost, estimated_cost, completed_date, assets:property_assets!asset_id(asset_type, installation_date, expected_lifespan_years)')
          .not('asset_id', 'is', null)
          .eq('status', 'completed')

        if (!assetRepairs?.length) return { nudged: 0 }

        const byType: Record<string, RepairRecord[]> = {}

        for (const wo of assetRepairs) {
          const assetInfo = unwrapJoin(wo.assets)
          if (!assetInfo?.asset_type || !assetInfo.installation_date || !wo.completed_date) continue

          const installYear = new Date(assetInfo.installation_date).getFullYear()
          const repairYear   = new Date(wo.completed_date).getFullYear()
          const ageAtRepair  = Math.max(0, repairYear - installYear)
          const repairCost   = wo.actual_cost ?? wo.estimated_cost ?? 0

          ;(byType[assetInfo.asset_type] ??= []).push({
            ageAtRepair, repairCost, assetType: assetInfo.asset_type,
          })
        }

        const { data: currentStandards } = await supabase
          .from('asset_type_standards')
          .select('asset_type, age_weight, condition_weight, lifespan_min_years, lifespan_max_years')

        const updates: Array<{
          asset_type:        string
          age_weight:        number
          condition_weight:  number
          weight_updated_at: string
        }> = []
        const oldWeightsByType: Record<string, { age_weight: number; condition_weight: number }> = {}

        for (const [assetType, repairs] of Object.entries(byType)) {
          const std = currentStandards?.find((s) => s.asset_type === assetType)
          if (!std) continue

          const nudge = computeWeightNudge(repairs, std)
          if (!nudge) continue

          updates.push({
            asset_type:        assetType,
            ...nudge,
            weight_updated_at: new Date().toISOString(),
          })
          oldWeightsByType[assetType] = {
            age_weight:       std.age_weight,
            condition_weight: std.condition_weight,
          }
        }

        if (updates.length) {
          await supabase
            .from('asset_type_standards')
            .upsert(updates, { onConflict: 'asset_type' })

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

        return { nudged: updates.length, asset_types_with_data: Object.keys(byType).length }
      })
    }

    // COI & license expiry escalation (formerly 8.13) was removed — fully
    // superseded by cron-daily-wrapup's compliance digest section, which
    // re-queries vendor_compliance_documents independently with its own
    // 30-day lookahead window.

    return {
      assets_scored: activeAssets.length,
    }
  }
)
