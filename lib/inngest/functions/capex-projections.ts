/**
 * Monthly CapEx Projection Generator (8.16)
 *
 * Cron: 1st of each month at midnight UTC
 * For each org, buckets active assets into replacement-year projections
 * using installation_date + expected lifespan. Stores result in
 * org_milestones (key: capex_projection_{year}).
 */

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'

export interface CapExProjectionItem {
  asset_id:         string
  asset_name:       string
  property_id:      string   // required for owner portal property-scoped filtering
  property_name:    string
  asset_type:       string
  replacement_year: number
  cost_low:         number
  cost_high:        number
  health_score:     number | null
  age_years:        number
  pct_of_lifespan:  number
}

export interface CapExProjectionYear {
  total_low:  number
  total_high: number
  items:      CapExProjectionItem[]
}

export interface CapExProjectionPayload {
  generated_at: string
  projections:  Record<number, CapExProjectionYear>
}

export const generateCapexProjections = inngest.createFunction(
  {
    id:      'generate-capex-projections',
    name:    'Generate CapEx Projections',
    retries: 2,
  },
  { cron: '0 0 1 * *' },
  async ({ step, logger }) => {
    const currentYear = new Date().getFullYear()

    const orgs = await step.run('fetch-orgs', async () => {
      const supabase = createServiceClient()
      const pageSize = 1000
      const all: { id: string }[] = []
      for (let from = 0; ; from += pageSize) {
        const { data } = await supabase
          .from('organizations')
          .select('id')
          .range(from, from + pageSize - 1)
        if (!data?.length) break
        all.push(...data)
        if (data.length < pageSize) break
      }
      return all
    })

    let processedOrgs = 0

    for (const org of orgs) {
      await step.run(`project-org-${org.id}`, async () => {
        const supabase = createServiceClient()
        const [{ data: assets }, { data: standards }, { data: properties }] =
          await Promise.all([
            supabase
              .from('property_assets')
              .select('id, name, asset_type, property_id, installation_date, expected_lifespan_years, estimated_replacement_cost, health_score')
              .eq('org_id', org.id)
              .eq('is_active', true)
              .not('installation_date', 'is', null),
            supabase
              .from('asset_type_standards')
              .select('asset_type, lifespan_min_years, lifespan_max_years, avg_replacement_cost_low, avg_replacement_cost_high'),
            supabase
              .from('properties')
              .select('id, name')
              .eq('org_id', org.id)
              .eq('is_active', true),
          ])

        const propertyMap  = Object.fromEntries((properties ?? []).map((p) => [p.id, p.name]))
        const standardsMap = Object.fromEntries((standards ?? []).map((s) => [s.asset_type, s]))

        const projections: Record<number, CapExProjectionYear> = {}

        for (const asset of assets ?? []) {
          if (!asset.installation_date) continue

          const std      = standardsMap[asset.asset_type as string]
          const ageYears = currentYear - new Date(asset.installation_date).getFullYear()
          const lifespan = asset.expected_lifespan_years
            ?? (std ? Math.round((std.lifespan_min_years + std.lifespan_max_years) / 2) : 15)
          const yearsLeft = lifespan - ageYears

          if (yearsLeft > 10) continue

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
          })
        }

        const payload: CapExProjectionPayload = {
          generated_at: new Date().toISOString(),
          projections,
        }

        await supabase
          .from('org_milestones')
          .upsert(
            { org_id: org.id, milestone: `capex_projection_${currentYear}`, value: payload },
            { onConflict: 'org_id,milestone' }
          )

        await logAuditEvent({
          orgId:      org.id,
          action:     'asset.capex_projection.triggered',
          targetType: 'org',
          targetId:   org.id,
          metadata:   { source: 'monthly_cron' },
        })

        logger.info(`[CapEx] Org ${org.id}: ${Object.keys(projections).length} replacement years`)
        processedOrgs++
      })
    }

    return { processed_orgs: processedOrgs, tax_year: currentYear }
  }
)
