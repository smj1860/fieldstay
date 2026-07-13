// lib/inngest/functions/asset-scan.ts
// ============================================================
// Triggered by: asset/scan_requested
// Fired by:     app/api/assets/request-scan/route.ts, whenever a crew member
//               attaches a data-plate photo during asset discovery
//               (app/crew/assets/[propertyId]/page.tsx).
//
// Runs the same Claude vision extraction as the PM's synchronous
// "Scan Data Plate" button (lib/assets/scan-data-plate.ts) but in the
// background, since crew are often on a slow connection at the property and
// shouldn't be blocked on a ~60s call. Only fills in fields the asset
// doesn't already have — a crew member's manual make/model entry (or a
// PM's later edit) is never overwritten by a scan result.
//
// If all retries are exhausted (e.g. the photo download keeps failing),
// scan_status is left at 'processing' rather than 'failed' — an accepted
// MVP gap mirroring asset-manual-lookup.ts's own tradeoff note. The photo
// itself already satisfies discovery (photo_url is set at insert time), so
// this only means make/model stay blank until a PM fills them in manually.
// ============================================================

import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { scanDataPlateImage, isValidScanMediaType } from '@/lib/assets/scan-data-plate'

const PHOTO_BUCKET = 'turnover-photos'

export const assetDataPlateScan = inngest.createFunction(
  {
    id:      'asset-data-plate-scan',
    name:    'Asset: Data Plate Scan',
    retries: 2,
    concurrency: { limit: 5 },
  },
  { event: 'asset/scan_requested' as const },
  async ({ event, step, logger }) => {
    const { org_id, asset_id, storage_path, media_type } = event.data

    await step.run('mark-processing', async () => {
      const supabase = createServiceClient()
      await supabase
        .from('property_assets')
        .update({ scan_status: 'processing' })
        .eq('id', asset_id)
        .eq('org_id', org_id)
    })

    const result = await step.run('scan-image', async () => {
      if (!isValidScanMediaType(media_type)) {
        throw new Error(`Unsupported media type: ${media_type}`)
      }

      const supabase = createServiceClient()
      const { data: blob, error } = await supabase.storage.from(PHOTO_BUCKET).download(storage_path)
      if (error || !blob) throw new Error(`Could not download photo: ${error?.message ?? 'not found'}`)

      const arrayBuffer = await blob.arrayBuffer()
      const imageBase64 = Buffer.from(arrayBuffer).toString('base64')
      return scanDataPlateImage(imageBase64, media_type)
    })

    await step.run('save-result', async () => {
      const supabase = createServiceClient()

      const { data: asset } = await supabase
        .from('property_assets')
        .select('make, model, serial_number, manufacture_date, notes, scan_status')
        .eq('id', asset_id)
        .eq('org_id', org_id)
        .single()

      if (!asset) return

      const found = Boolean(result.make || result.model || result.serial_number)
      const updates: Record<string, unknown> = {}

      // Never downgrade an already-completed scan — a duplicate/retried run
      // disagreeing on `found` (LLM output isn't perfectly deterministic)
      // shouldn't flip a good result back to 'failed'.
      if (asset.scan_status !== 'completed') {
        updates.scan_status = found ? 'completed' : 'failed'
      }

      // Only fill in fields the asset doesn't already have — never
      // overwrite a crew member's manual entry or a PM's later edit.
      if (!asset.make && result.make)                    updates.make = result.make
      if (!asset.model && result.model)                  updates.model = result.model
      if (!asset.serial_number && result.serial_number)   updates.serial_number = result.serial_number
      if (!asset.manufacture_date && result.manufacture_year) {
        updates.manufacture_date = `${result.manufacture_year}-01-01`
      }
      // Guard against appending the same capacity line twice on a retried
      // or duplicate run.
      if (result.capacity && !asset.notes?.includes(`Capacity: ${result.capacity}`)) {
        updates.notes = asset.notes ? `${asset.notes}\nCapacity: ${result.capacity}` : `Capacity: ${result.capacity}`
      }

      const { error } = await supabase.from('property_assets').update(updates).eq('id', asset_id).eq('org_id', org_id)
      if (error) throw new Error(`property_assets update failed: ${error.message}`)
    })

    logger.info(`[asset-scan] ${asset_id}: ${result.confidence} confidence`)
    return { asset_id, confidence: result.confidence }
  }
)
