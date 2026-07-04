/**
 * Annual Depreciation Ledger Generator (8.19)
 *
 * Triggers:
 *  - Manual: 'asset/depreciation-ledger-requested' event (button click from dashboard)
 *  - Automatic: January 1st each year for the prior tax year ('0 0 1 1 *')
 *
 * Steps:
 *  1. Load all active assets with placed_in_service_date + purchase_price
 *  2. Fetch prior cumulative depreciation per asset from existing entries
 *  3. Calculate each asset's entry for the requested tax year
 *  4. Upsert into asset_depreciation_entries (UNIQUE on asset_id + tax_year)
 *  5. Store summary in org_milestones with key depreciation_ledger_{tax_year}
 */

import { inngest }                    from '@/lib/inngest/client'
import { createServiceClient }         from '@/lib/supabase/server'
import { calculateAnnualDepreciation } from '@/lib/assets/depreciation'

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

    // ── Step 1: Load active assets ──────────────────────────────────────────

    const assets = await step.run('load-assets', async () => {
      const supabase = createServiceClient()
      const query = supabase
        .from('property_assets')
        .select('id, org_id, property_id, name, asset_type, placed_in_service_date, purchase_price, salvage_value, macrs_class')
        .eq('is_active', true)
        .not('placed_in_service_date', 'is', null)
        .not('purchase_price', 'is', null)

      // Cron has no event data — runs for all orgs.
      // Manual trigger from the PM dashboard provides org_id — scope to that org.
      if (triggerOrgId) {
        query.eq('org_id', triggerOrgId)
      }

      const { data } = await query
      return data ?? []
    })

    if (!assets.length) {
      logger.info('[Depreciation] No eligible assets found')
      return { tax_year: taxYear, entries_written: 0 }
    }

    // ── Step 2: Fetch prior cumulative depreciation per asset ───────────────

    const priorEntries = await step.run('fetch-prior-cumulative', async () => {
      const supabase = createServiceClient()
      const assetIds = assets.map((a) => a.id)
      const { data } = await supabase
        .from('asset_depreciation_entries')
        .select('asset_id, current_year_depreciation')
        .in('asset_id', assetIds)
        .lt('tax_year', taxYear)
      return data ?? []
    })

    // Sum prior depreciation per asset
    const priorCumulativeMap: Record<string, number> = {}
    for (const entry of priorEntries) {
      priorCumulativeMap[entry.asset_id] =
        (priorCumulativeMap[entry.asset_id] ?? 0) + (entry.current_year_depreciation as number)
    }

    // ── Step 3 & 4: Calculate + upsert entries per org ─────────────────────

    // Group assets by org for per-org milestone steps
    const orgMap: Record<string, typeof assets> = {}
    for (const asset of assets) {
      if (!orgMap[asset.org_id]) orgMap[asset.org_id] = []
      orgMap[asset.org_id].push(asset)
    }

    let totalWritten = 0

    for (const [orgId, orgAssets] of Object.entries(orgMap)) {
      const written = await step.run(`upsert-entries-${orgId}`, async () => {
        const supabase = createServiceClient()
        const entries = []

        for (const asset of orgAssets) {
          const prior = priorCumulativeMap[asset.id] ?? 0
          const entry = calculateAnnualDepreciation(asset as Parameters<typeof calculateAnnualDepreciation>[0], taxYear, prior)
          if (entry) entries.push(entry)
        }

        if (!entries.length) return 0

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

        logger.info(`[Depreciation] Org ${orgId}: ${entries.length} entries for ${taxYear}`)
        return entries.length
      })

      totalWritten += written
    }

    return { tax_year: taxYear, entries_written: totalWritten }
  }
)
