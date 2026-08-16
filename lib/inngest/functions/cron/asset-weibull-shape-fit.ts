/**
 * Monthly: fits a real per-asset-type Weibull shape parameter from observed
 * age-at-replacement data (property_assets.replaced_at, set only by
 * replace_property_asset() — see its migration), and stores it on
 * asset_type_standards.weibull_shape for calculateHealthScoreBreakdown to
 * prefer over the shared WEIBULL_SHAPE default.
 *
 * Platform-level, not fanned out per org — asset_type_standards is a global
 * reference table, same reasoning as the Bayesian age/condition weight nudge
 * in cron/asset-health.ts, which this is a sibling of. Expect this to do
 * nothing for a long while: it needs MIN_REPLACEMENTS real replacement
 * events for a given type, platform-wide, before it can fit anything at all.
 * That's expected, not a bug — see the migration comment on replaced_at.
 */

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents }      from '@/lib/audit'
import { unwrapList }          from '@/lib/supabase/unwrap'
import { foldAllRows }         from '@/lib/inngest/paginate'
import { assetAgeBasis }       from '@/lib/assets/age-basis'
import { fitWeibullShape }     from '@/lib/assets/weibull-fit'
import type { TablesInsert }   from '@/types/database'

/** asset_type_standards is a fixed platform reference table (21+ asset types). */
const ASSET_TYPE_STANDARDS_LIMIT = 200

const MS_PER_YEAR = 365.25 * 86_400_000

export const assetWeibullShapeFit = inngest.createFunction(
  {
    id:      'cron-asset-weibull-shape-fit',
    name:    'Cron: Asset Weibull Shape Fit',
    retries: 2,
  },
  { cron: '0 14 1 * *' },
  async ({ step, logger }) => {
    const fitted = await step.run('fit-and-persist-weibull-shapes', async () => {
      const supabase = createServiceClient({ system: 'inngest:asset-weibull-shape-fit' })

      // Folded, not accumulated whole — same reasoning as the weight nudge's
      // repair-history scan: this needs ages-at-replacement per type, not
      // every replaced asset's full row, and it is platform-wide.
      const agesByType = await foldAllRows<
        { asset_type: string; installation_date: string | null; manufacture_date: string | null; replaced_at: string | null },
        Map<string, number[]>
      >(
        (from, to) => supabase
          .from('property_assets')
          .select('asset_type, installation_date, manufacture_date, replaced_at')
          .not('replaced_at', 'is', null)
          // Either date dates the asset — see lib/assets/age-basis.ts. The
          // fold below still drops a row with neither, so this cannot admit
          // an undated one; it stops discarding the scanned ones.
          .or('installation_date.not.is.null,manufacture_date.not.is.null')
          .order('id', { ascending: true })
          .range(from, to),
        new Map<string, number[]>(),
        (acc, page) => {
          for (const row of page) {
            const ageBasis = assetAgeBasis(row)
            if (!ageBasis || !row.replaced_at) continue
            const ageYears = (
              new Date(row.replaced_at).getTime() - new Date(ageBasis.date).getTime()
            ) / MS_PER_YEAR
            const ages = acc.get(row.asset_type) ?? []
            ages.push(ageYears)
            acc.set(row.asset_type, ages)
          }
          return acc
        },
        { label: 'property_assets(weibull-fit)' },
      )

      if (!agesByType.size) return { fitted: 0 }

      const currentStandards = unwrapList(
        await supabase
          .from('asset_type_standards')
          .select('asset_type, display_name, lifespan_min_years, lifespan_max_years, weibull_shape')
          .limit(ASSET_TYPE_STANDARDS_LIMIT),
        { site: 'inngest.asset-weibull-shape-fit.standards' },
      )

      const updates: TablesInsert<'asset_type_standards'>[] = []
      const before: Record<string, number | null> = {}
      const sampleSizes: Record<string, number> = {}

      for (const [assetType, ages] of agesByType) {
        const std = currentStandards?.find((s) => s.asset_type === assetType)
        if (!std) continue

        const result = fitWeibullShape(ages)
        if (!result) continue

        // No point rewriting the row (or the audit log) for a fit that
        // landed on the same value already stored, e.g. re-run with no new
        // replacements since last month.
        if (std.weibull_shape !== null && Math.abs(std.weibull_shape - result.shape) < 0.01) continue

        updates.push({
          asset_type:         std.asset_type,
          display_name:       std.display_name,
          lifespan_min_years: std.lifespan_min_years,
          lifespan_max_years: std.lifespan_max_years,
          weibull_shape:            result.shape,
          weibull_shape_updated_at: new Date().toISOString(),
        })
        before[assetType]       = std.weibull_shape
        sampleSizes[assetType]  = result.sampleSize
      }

      if (updates.length) {
        const { error } = await supabase
          .from('asset_type_standards')
          .upsert(updates, { onConflict: 'asset_type' })

        if (error) {
          throw new Error(`asset_type_standards weibull_shape upsert failed: ${error.message}`)
        }

        await logAuditEvents(
          updates.map((u) => ({
            action:     'asset.weibull_shape.fitted' as const,
            targetType: 'asset_type_standard',
            targetId:   u.asset_type!,
            metadata:   {
              old_weibull_shape: before[u.asset_type!] ?? null,
              new_weibull_shape: u.weibull_shape,
              sample_size:        sampleSizes[u.asset_type!],
            },
          }))
        )
      }

      return { fitted: updates.length }
    })

    logger.info(`Asset Weibull shape fit: updated ${fitted.fitted} asset type(s)`)
    return fitted
  }
)
