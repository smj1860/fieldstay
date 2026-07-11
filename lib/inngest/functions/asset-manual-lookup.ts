// lib/inngest/functions/asset-manual-lookup.ts
// ============================================================
// Triggered by: asset/manual_lookup.requested
// Fired by:     createAsset/updateAsset/bulkImportAssets in
//               app/(dashboard)/properties/actions.ts, whenever an asset is
//               saved with both make and model set.
//
// Idempotent: a row already existing for (org_id, asset_type, make, model)
// — whether a manual was found or not — means this is a no-op. A manual
// that becomes available online later than the first lookup attempt won't
// be picked up automatically; that's an acceptable MVP tradeoff, not a
// silent gap — a periodic retry-not-found cron would be the natural
// follow-up if this turns out to matter in practice.
// ============================================================

import { inngest }                 from '@/lib/inngest/client'
import { createServiceClient }     from '@/lib/supabase/server'
import { findManualUrl }           from '@/lib/assets/manual-lookup'
import type { AssetType }          from '@/types/database'

// Trim + lowercase so "Whirlpool"/"whirlpool "/"WHIRLPOOL" all resolve to
// the same asset_manuals row instead of creating near-duplicate lookups.
function normalize(value: string): string {
  return value.trim().toLowerCase()
}

export const assetManualLookup = inngest.createFunction(
  {
    id:      'asset-manual-lookup',
    name:    'Asset: Manual Lookup',
    retries: 2,
    concurrency: { limit: 5 },
  },
  { event: 'asset/manual_lookup.requested' as const },
  async ({ event, step, logger }) => {
    const { org_id, asset_type, make, model } = event.data
    const normalizedMake  = normalize(make)
    const normalizedModel = normalize(model)

    const existing = await step.run('check-existing', async () => {
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('asset_manuals')
        .select('id')
        .eq('org_id', org_id)
        .eq('asset_type', asset_type)
        .eq('make', normalizedMake)
        .eq('model', normalizedModel)
        .maybeSingle()

      // Throw (rather than silently treating this as "no existing row") so
      // Inngest retries the whole check — proceeding blind here risks a
      // wasted paid lookup call on every retry of a transient DB hiccup,
      // and the row we're checking for is exactly what prevents that.
      if (error) throw new Error(`asset_manuals existence check failed: ${error.message}`)
      return data
    })

    if (existing) {
      return { skipped: true, reason: 'already_attempted' }
    }

    const result = await step.run('find-manual-url', async () => {
      return findManualUrl(asset_type as AssetType, normalizedMake, normalizedModel)
    })

    await step.run('save-result', async () => {
      const supabase = createServiceClient()
      const { error } = await supabase
        .from('asset_manuals')
        .insert({
          org_id,
          asset_type,
          make:        normalizedMake,
          model:       normalizedModel,
          source_url:  result.sourceUrl,
          found_via:   result.foundVia,
          verified_at: result.sourceUrl ? new Date().toISOString() : null,
        })

      // 23505 = unique_violation — a concurrent save of the same make/model
      // already inserted the row first; safe to ignore.
      if (error && error.code !== '23505') {
        throw new Error(`asset_manuals insert failed: ${error.message}`)
      }
    })

    logger.info(
      `[asset-manual-lookup] ${org_id}/${asset_type}/${normalizedMake}/${normalizedModel}: ` +
      (result.sourceUrl ? `found ${result.sourceUrl}` : 'not found')
    )

    return { found: result.sourceUrl !== null }
  }
)
