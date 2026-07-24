/**
 * On-Demand CapEx Projection for a single org (CLAUDE_57_0)
 *
 * Triggered by: 'asset/capex-projection-requested'
 * Fired from:   capital-planning/actions.ts::triggerCapexProjections()
 *               which requires org membership before firing.
 *
 * Mirrors generateCapexProjections but scoped to one org so the monthly
 * cron and the on-demand button produce identical output format.
 */

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import type {
  CapExProjectionItem,
  CapExProjectionYear,
  CapExProjectionPayload,
} from '@/lib/inngest/functions/capex-projections'

const HORIZON_YEARS = 10

export const triggerCapexProjectionForOrg = inngest.createFunction(
  {
    id:      'trigger-capex-projection-for-org',
    name:    'CapEx Projection: On-Demand (Single Org)',
    retries: 2,
  },
  { event: 'asset/capex-projection-requested' },
  async ({ event, step, logger }) => {
    const { org_id } = event.data
    const currentYear = new Date().getFullYear()

    const result = await step.run('project-org', async () => {
      const supabase = createServiceClient({ system: 'inngest:capex-projection-trigger' })

      const [{ data: assets }, { data: standards }, { data: properties }] =
        await Promise.all([
          supabase
            .from('property_assets')
            .select('id, name, asset_type, property_id, installation_date, expected_lifespan_years, estimated_replacement_cost, health_score')
            .eq('org_id', org_id)
            .eq('is_active', true)
            .not('installation_date', 'is', null),
          supabase
            .from('asset_type_standards')
            .select('asset_type, lifespan_min_years, lifespan_max_years, avg_replacement_cost_low, avg_replacement_cost_high'),
          supabase
            .from('properties')
            .select('id, name')
            .eq('org_id', org_id)
            .eq('is_active', true),
        ])

      const propertyMap  = Object.fromEntries((properties ?? []).map((p) => [p.id, p.name]))
      const standardsMap = Object.fromEntries((standards ?? []).map((s) => [s.asset_type, s]))
      const projections: Record<number, CapExProjectionYear> = {}

      for (const asset of assets ?? []) {
        if (!asset.installation_date) continue

        const std       = standardsMap[asset.asset_type as string]
        const ageYears  = currentYear - new Date(asset.installation_date).getFullYear()
        const lifespan  = asset.expected_lifespan_years
          ?? (std ? Math.round((std.lifespan_min_years + std.lifespan_max_years) / 2) : 15)
        const yearsLeft = lifespan - ageYears

        if (yearsLeft > HORIZON_YEARS) continue

        const costLow  = (asset.estimated_replacement_cost ?? std?.avg_replacement_cost_low  ?? 0) as number
        const costHigh = (asset.estimated_replacement_cost ?? std?.avg_replacement_cost_high ?? costLow) as number

        const replacementYear = currentYear + Math.max(0, Math.ceil(yearsLeft))
        const pctOfLifespan   = Math.min(100, Math.round((ageYears / lifespan) * 100))

        if (!projections[replacementYear]) {
          projections[replacementYear] = { total_low: 0, total_high: 0, items: [] }
        }

        projections[replacementYear].total_low  += costLow
        projections[replacementYear].total_high += costHigh
        projections[replacementYear].items.push({
          asset_id:         asset.id,
          asset_name:       asset.name,
          property_id:      asset.property_id,
          property_name:    (propertyMap[asset.property_id] as string) ?? 'Unknown',
          asset_type:       asset.asset_type as string,
          replacement_year: replacementYear,
          cost_low:         costLow,
          cost_high:        costHigh,
          health_score:     asset.health_score as number | null,
          age_years:        ageYears,
          pct_of_lifespan:  pctOfLifespan,
        } satisfies CapExProjectionItem)
      }

      const payload: CapExProjectionPayload = {
        generated_at: new Date().toISOString(),
        projections,
      }

      await supabase
        .from('org_milestones')
        .upsert(
          { org_id, milestone: `capex_projection_${currentYear}`, value: payload },
          { onConflict: 'org_id,milestone' }
        )

      return {
        years_with_items: Object.keys(projections).length,
        total_assets:     (assets ?? []).length,
      }
    })

    logger.info(`[CapEx on-demand] org=${org_id} years=${result.years_with_items} assets=${result.total_assets}`)
    return { org_id, ...result }
  }
)
