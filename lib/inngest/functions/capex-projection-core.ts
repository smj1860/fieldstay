/**
 * Shared CapEx projection core.
 *
 * The monthly cron (capex-projections.ts) and the on-demand button
 * (capex-projection-trigger.ts) used to carry two byte-for-byte copies of the
 * same bucketing math and the same org_milestones write. That duplication is
 * exactly how the two paths drift into producing different payloads for the
 * same org — and the payload shape is consumed by the capital-planning page,
 * the owner portal, and the CPA CSV export, so a drift there is a silent
 * reporting bug rather than a crash. Both now call `runCapexProjectionForOrg`.
 *
 * Every read here is explicitly bounded (see the max_rows = 1000 rule in
 * CLAUDE.md): the per-org asset and property scans paginate via `fetchAllRows`,
 * and `asset_type_standards` is a fixed platform reference table read once per
 * invocation under an explicit `.limit()`.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/inngest/paginate'

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

/** Assets more than this many years from end-of-life are out of the plan window. */
export const CAPEX_HORIZON_YEARS = 10

/** Fallback lifespan when neither the asset nor its type standard supplies one. */
const DEFAULT_LIFESPAN_YEARS = 15

/**
 * `asset_type_standards` is a fixed platform reference table (21 asset types
 * today) and is NOT org-scoped. It is read once per handler invocation — i.e.
 * once per org rather than once per org per asset — and deliberately not passed
 * through the fan-out event: a reference table on an event payload is both dead
 * weight on every message and a snapshot that goes stale the moment the
 * Bayesian weight nudge in cron/asset-health.ts rewrites a row mid-run.
 */
const ASSET_TYPE_STANDARDS_LIMIT = 200

export interface ProjectionAssetRow {
  id:                          string
  name:                        string
  asset_type:                  string
  property_id:                 string
  installation_date:           string | null
  expected_lifespan_years:     number | null
  estimated_replacement_cost:  number | null
  health_score:                number | null
}

export interface AssetTypeStandardRow {
  asset_type:                string
  lifespan_min_years:        number
  lifespan_max_years:        number
  avg_replacement_cost_low:  number
  avg_replacement_cost_high: number
}

interface PropertyRow {
  id:   string
  name: string
}

/**
 * Pure: buckets assets into replacement-year projections. Extracted so the
 * bucketing rules are testable without a Supabase double, and so the cron and
 * on-demand paths cannot diverge.
 */
export function buildProjections(
  assets:          ProjectionAssetRow[],
  standards:       AssetTypeStandardRow[],
  propertyNameById: Record<string, string>,
  currentYear:     number,
): Record<number, CapExProjectionYear> {
  const standardsMap = Object.fromEntries(standards.map((s) => [s.asset_type, s]))
  const projections: Record<number, CapExProjectionYear> = {}

  for (const asset of assets) {
    if (!asset.installation_date) continue

    const std       = standardsMap[asset.asset_type]
    const ageYears  = currentYear - new Date(asset.installation_date).getFullYear()
    const lifespan  = asset.expected_lifespan_years
      ?? (std ? Math.round((std.lifespan_min_years + std.lifespan_max_years) / 2) : DEFAULT_LIFESPAN_YEARS)
    const yearsLeft = lifespan - ageYears

    if (yearsLeft > CAPEX_HORIZON_YEARS) continue

    const costLow  = asset.estimated_replacement_cost ?? std?.avg_replacement_cost_low  ?? 0
    const costHigh = asset.estimated_replacement_cost ?? std?.avg_replacement_cost_high ?? costLow

    const replacementYear = currentYear + Math.max(0, Math.ceil(yearsLeft))
    const pctOfLifespan   = Math.min(100, Math.round((ageYears / lifespan) * 100))

    projections[replacementYear] ??= { total_low: 0, total_high: 0, items: [] }

    projections[replacementYear].total_low  += costLow
    projections[replacementYear].total_high += costHigh
    projections[replacementYear].items.push({
      asset_id:         asset.id,
      asset_name:       asset.name,
      property_id:      asset.property_id,
      property_name:    propertyNameById[asset.property_id] ?? 'Unknown',
      asset_type:       asset.asset_type,
      replacement_year: replacementYear,
      cost_low:         costLow,
      cost_high:        costHigh,
      health_score:     asset.health_score,
      age_years:        ageYears,
      pct_of_lifespan:  pctOfLifespan,
    } satisfies CapExProjectionItem)
  }

  return projections
}

export interface CapexProjectionResult {
  years_with_items: number
  total_assets:     number
}

/**
 * Loads one org's assets/properties, buckets them, and upserts the result into
 * `org_milestones` under `capex_projection_{currentYear}`.
 *
 * The upsert is keyed on the existing UNIQUE (org_id, milestone), so a retry
 * (or the on-demand button racing the monthly cron) recomputes and overwrites
 * the same row rather than creating a second one.
 */
export async function runCapexProjectionForOrg(
  supabase:    SupabaseClient,
  orgId:       string,
  currentYear: number,
): Promise<CapexProjectionResult> {
  const [assets, standardsResult, properties] = await Promise.all([
    fetchAllRows<ProjectionAssetRow>(
      (from, to) => supabase
        .from('property_assets')
        .select('id, name, asset_type, property_id, installation_date, expected_lifespan_years, estimated_replacement_cost, health_score')
        .eq('org_id', orgId)
        .eq('is_active', true)
        .not('installation_date', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
      { label: `property_assets(capex)[org=${orgId}]` },
    ),
    supabase
      .from('asset_type_standards')
      .select('asset_type, lifespan_min_years, lifespan_max_years, avg_replacement_cost_low, avg_replacement_cost_high')
      .limit(ASSET_TYPE_STANDARDS_LIMIT),
    fetchAllRows<PropertyRow>(
      (from, to) => supabase
        .from('properties')
        .select('id, name')
        .eq('org_id', orgId)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to),
      { label: `properties(capex)[org=${orgId}]` },
    ),
  ])

  const standards = (standardsResult.data ?? []) as AssetTypeStandardRow[]
  const propertyNameById = Object.fromEntries(properties.map((p) => [p.id, p.name]))

  const projections = buildProjections(assets, standards, propertyNameById, currentYear)

  const payload: CapExProjectionPayload = {
    generated_at: new Date().toISOString(),
    projections,
  }

  const { error: upsertError } = await supabase
    .from('org_milestones')
    .upsert(
      { org_id: orgId, milestone: `capex_projection_${currentYear}`, value: payload },
      { onConflict: 'org_id,milestone' },
    )

  if (upsertError) {
    throw new Error(`capex_projection upsert failed for org ${orgId}: ${upsertError.message}`)
  }

  return {
    years_with_items: Object.keys(projections).length,
    total_assets:     assets.length,
  }
}
