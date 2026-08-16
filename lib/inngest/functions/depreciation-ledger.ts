/**
 * Annual Depreciation Ledger Generator (8.19)
 *
 * Triggers:
 *  - Manual: 'asset/depreciation-ledger-requested' event (button click from dashboard)
 *  - Automatic: January 1st each year for the prior tax year ('0 0 1 1 *')
 *
 * DISPATCHER ONLY. The previous single-invocation version had two distinct
 * scalability defects:
 *
 *  1. `for (const [orgId, orgAssets] of Object.entries(orgMap)) { await
 *     step.run(...) }` — one Inngest step per tenant in a single run, the same
 *     shape converted in the six crons of the 2026-07-30 scalability pass.
 *  2. Worse: it loaded EVERY asset platform-wide and returned that array as a
 *     STEP OUTPUT, so Inngest re-sent it on every subsequent step. At 150
 *     tenants x 30 properties x 10 assets that is ~45,000 rows of memoized
 *     state per step — exactly the step-output size problem that forced
 *     cron/asset-health.ts to stop returning `activeAssets`. The platform-wide
 *     `asset_depreciation_entries` prior-year read had the same shape.
 *
 * Now the dispatcher resolves DISTINCT org ids only (one small string array)
 * and each per-org handler loads its own org's assets and its own org's prior
 * entries. Nothing platform-wide is ever held in memory or in step state.
 *
 * The math is unchanged: prior cumulative depreciation is still the sum of
 * `current_year_depreciation` across every entry for that asset with
 * `tax_year < taxYear`. Scoping that read by `org_id` instead of by an
 * `.in(assetIds)` list is equivalent, because an entry and its asset always
 * share an org — the map is only ever read by asset id.
 *
 * Idempotency is unchanged: the entries upsert still targets
 * UNIQUE (asset_id, tax_year) via `onConflict: 'asset_id,tax_year'`, so a
 * retry (or a re-run of the same tax year) recomputes and overwrites the same
 * rows rather than accumulating duplicates.
 */

import { inngest }                     from '@/lib/inngest/client'
import { createServiceClient }          from '@/lib/supabase/server'
import { calculateAnnualDepreciation }  from '@/lib/assets/depreciation'
import type { Enums } from '@/types/database'
import { logAuditEvent }                from '@/lib/audit'
import { fetchAllRows, fetchDistinctOrgIds } from '@/lib/inngest/paginate'

// Mirrors the SELECT below against the live column nullability. The query
// filters purchase_price and the date columns, but a `.not(...)`/`.or(...)`
// filter narrows rows, not types — the loop below re-checks them.
interface LedgerAssetRow {
  id:                     string
  org_id:                 string
  property_id:            string
  name:                   string
  asset_type:             Enums<'asset_type'>
  placed_in_service_date: string | null
  installation_date:      string | null
  manufacture_date:       string | null
  purchase_price:         number | null
  salvage_value:          number | null
  macrs_class:            Enums<'macrs_class'> | null
}

export const generateDepreciationLedger = inngest.createFunction(
  {
    id:      'generate-depreciation-ledger',
    name:    'Generate Depreciation Ledger',
    retries: 3,
  },
  [
    { event: 'asset/depreciation-ledger-requested' as const },
    { cron:  '0 0 1 1 *' },  // January 1st — auto-run for prior year
  ],
  async ({ event, step, logger }) => {

    // Cron has no event; use prior year. Event-triggered uses provided year.
    const taxYear: number = (event as { data?: { org_id?: string; tax_year?: number } })?.data?.tax_year
      ?? new Date().getFullYear() - 1

    // Determine if this is a manual trigger (has org_id) or the annual cron (all orgs).
    const triggerOrgId: string | null =
      (event as { data?: { org_id?: string } })?.data?.org_id ?? null

    const orgIds = await step.run('resolve-orgs', async () => {
      // Manual trigger from the PM dashboard names its org — no scan needed.
      if (triggerOrgId) return [triggerOrgId]

      const supabase = createServiceClient({ system: 'inngest:depreciation-ledger' })
      return fetchDistinctOrgIds(
        (from, to) => supabase
          .from('property_assets')
          .select('org_id')
          .eq('is_active', true)
          // Any of the three dates qualifies — see lib/assets/age-basis.ts.
          // placed_in_service_date alone skipped every org whose assets are
          // dated only by a recorded install or a scanned nameplate.
          .or('placed_in_service_date.not.is.null,installation_date.not.is.null,manufacture_date.not.is.null')
          .not('purchase_price', 'is', null)
          .order('org_id', { ascending: true })
          .range(from, to),
        { label: 'property_assets.org_id(depreciation)' },
      )
    })

    logger.info(`[Depreciation] dispatching ${orgIds.length} org(s) for ${taxYear}`)

    if (orgIds.length) {
      await step.sendEvent(
        'fan-out-depreciation-ledger',
        orgIds.map((orgId) => ({
          name: 'org/depreciation_ledger.requested' as const,
          data: { org_id: orgId, tax_year: taxYear },
        })),
      )
    }

    return { tax_year: taxYear, dispatched: orgIds.length }
  }
)

/**
 * Per-org depreciation ledger. One invocation = one tenant: it loads its own
 * assets and its own prior-year entries (both paginated), computes, upserts,
 * and writes the org_milestones summary the capital-planning page polls.
 */
export const depreciationLedgerOrg = inngest.createFunction(
  {
    id:          'depreciation-ledger-org',
    name:        'Depreciation Ledger — per org',
    retries:     3,
    concurrency: { limit: 10 },
  },
  { event: 'org/depreciation_ledger.requested' },
  async ({ event, step, logger }) => {
    const { org_id: orgId, tax_year: taxYear } = event.data

    const written = await step.run('upsert-org-entries', async () => {
      const supabase = createServiceClient({ system: 'inngest:depreciation-ledger' })

      const assets = await fetchAllRows<LedgerAssetRow>(
        (from, to) => supabase
          .from('property_assets')
          .select('id, org_id, property_id, name, asset_type, placed_in_service_date, installation_date, manufacture_date, purchase_price, salvage_value, macrs_class')
          .eq('org_id', orgId)
          .eq('is_active', true)
          .or('placed_in_service_date.not.is.null,installation_date.not.is.null,manufacture_date.not.is.null')
          .not('purchase_price', 'is', null)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `property_assets(depreciation)[org=${orgId}]` },
      )

      if (!assets.length) return 0

      // Prior cumulative depreciation: every entry for this org's assets in a
      // tax year before the one being generated. Paginated — an org with a few
      // years of history and a large asset ledger runs past 1000 rows, and
      // truncating it here would understate `prior_cumulative_depreciation`
      // and overstate the ending adjusted basis on the CPA export.
      const priorEntries = await fetchAllRows<{ asset_id: string; current_year_depreciation: number }>(
        (from, to) => supabase
          .from('asset_depreciation_entries')
          .select('asset_id, current_year_depreciation')
          .eq('org_id', orgId)
          .lt('tax_year', taxYear)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `asset_depreciation_entries(prior)[org=${orgId}]` },
      )

      const priorCumulativeMap: Record<string, number> = {}
      for (const entry of priorEntries) {
        priorCumulativeMap[entry.asset_id] =
          (priorCumulativeMap[entry.asset_id] ?? 0) + entry.current_year_depreciation
      }

      const entries = []
      for (const asset of assets) {
        // The query filters these; re-checked here because a row filter is not
        // a type narrowing, and depreciation is meaningless without a cost
        // basis. calculateAnnualDepreciation resolves the service date across
        // the three columns and returns null when none of them is set.
        // macrs_class falls back to the column's own DEFAULT.
        if (asset.purchase_price === null) continue

        const prior = priorCumulativeMap[asset.id] ?? 0
        const entry = calculateAnnualDepreciation(
          {
            ...asset,
            purchase_price: asset.purchase_price,
            macrs_class:    asset.macrs_class ?? '5_year',
            salvage_value:  asset.salvage_value ?? 0,
          },
          taxYear,
          prior,
        )
        if (entry) entries.push(entry)
      }

      if (!entries.length) return 0

      // UNIQUE (asset_id, tax_year) — a retry overwrites, never duplicates.
      const { error } = await supabase
        .from('asset_depreciation_entries')
        .upsert(entries, { onConflict: 'asset_id,tax_year' })

      if (error) throw new Error(`[Depreciation] Upsert failed for org ${orgId}: ${error.message}`)

      // Store summary milestone
      const totalCurrentDepr = entries.reduce((s, e) => s + e.current_year_depreciation, 0)
      await supabase
        .from('org_milestones')
        .upsert(
          {
            org_id:    orgId,
            milestone: `depreciation_ledger_${taxYear}`,
            value: {
              generated_at:   new Date().toISOString(),
              tax_year:       taxYear,
              entry_count:    entries.length,
              total_depr:     Math.round(totalCurrentDepr * 100) / 100,
            },
          },
          { onConflict: 'org_id,milestone' }
        )

      await logAuditEvent({
        orgId,
        action:     'asset.depreciation_ledger.generated',
        targetType: 'organization',
        metadata:   { tax_year: taxYear, entries_count: entries.length },
      })

      logger.info(`[Depreciation] Org ${orgId}: ${entries.length} entries for ${taxYear}`)
      return entries.length
    })

    return { org_id: orgId, tax_year: taxYear, entries_written: written }
  }
)
