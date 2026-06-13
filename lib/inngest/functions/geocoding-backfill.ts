import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { geocodeZip } from '@/lib/geocoding'

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ⚠️ Cross-tenant by design: scans and updates lat/lng for every org's properties
// and vendors in a single run, since geocoding only writes non-sensitive coordinate
// data and batching per-org would multiply Mapbox API calls. This must remain an
// internal admin/ops operation — it must NEVER be triggerable from the PM dashboard
// UI or any org-scoped route handler/server action. Only fire `geocoding/backfill-requested`
// from internal admin tooling that bypasses normal org auth (e.g. a one-off ops script
// or a service-role-gated route). If this function is ever extended to read or expose
// fields beyond id/zip/lat/lng, it must be re-scoped to a single org_id first.
export const geocodingBackfill = inngest.createFunction(
  { id: 'geocoding-backfill', name: 'Backfill Property & Vendor Geocodes', retries: 1 },
  { event: 'geocoding/backfill-requested' },
  async ({ step }) => {

    const propertiesResult = await step.run('geocode-properties', async (): Promise<{ geocoded: number; skipped: number }> => {
      const supabase = createServiceClient()

      const { data: properties } = await supabase
        .from('properties')
        .select('id, zip')
        .is('lat', null)
        .not('zip', 'is', null)

      if (!properties?.length) return { geocoded: 0, skipped: 0 }

      let geocoded = 0
      let skipped  = 0

      for (const batch of chunk(properties, 10)) {
        for (const prop of batch) {
          const coords = await geocodeZip(prop.zip!)
          if (coords) {
            await supabase
              .from('properties')
              .update({ lat: coords.lat, lng: coords.lng })
              .eq('id', prop.id)
            geocoded++
          } else {
            skipped++
          }
          await sleep(200)
        }
      }

      return { geocoded, skipped }
    })

    const vendorsResult = await step.run('geocode-vendors', async (): Promise<{ geocoded: number; skipped: number }> => {
      const supabase = createServiceClient()

      const { data: vendors } = await supabase
        .from('vendors')
        .select('id, service_zip')
        .is('lat', null)
        .not('service_zip', 'is', null)

      if (!vendors?.length) return { geocoded: 0, skipped: 0 }

      let geocoded = 0
      let skipped  = 0

      for (const batch of chunk(vendors, 10)) {
        for (const vendor of batch) {
          const coords = await geocodeZip(vendor.service_zip!)
          if (coords) {
            await supabase
              .from('vendors')
              .update({ lat: coords.lat, lng: coords.lng })
              .eq('id', vendor.id)
            geocoded++
          } else {
            skipped++
          }
          await sleep(200)
        }
      }

      return { geocoded, skipped }
    })

    return {
      properties: propertiesResult,
      vendors:    vendorsResult,
    }
  }
)
