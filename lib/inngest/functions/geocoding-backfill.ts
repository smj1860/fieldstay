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

export const geocodingBackfill = inngest.createFunction(
  { id: 'geocoding-backfill', name: 'Backfill Property & Vendor Geocodes', retries: 1 },
  { event: 'geocoding/backfill-requested' },
  async ({ step }) => {

    const propertiesResult = await step.run('geocode-properties', async () => {
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

    const vendorsResult = await step.run('geocode-vendors', async () => {
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
