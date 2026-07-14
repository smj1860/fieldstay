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
      const pageSize = 1000
      const properties: { id: string; zip: string | null }[] = []
      for (let from = 0; ; from += pageSize) {
        const { data } = await supabase
          .from('properties')
          .select('id, zip')
          .is('lat', null)
          .not('zip', 'is', null)
          .range(from, from + pageSize - 1)
        if (!data?.length) break
        properties.push(...data)
        if (data.length < pageSize) break
      }

      if (!properties.length) return { geocoded: 0, skipped: 0 }

      // LOW-4: properties sharing a zip code resolve to the same coordinates —
      // geocode each unique zip once instead of once per property.
      const uniqueZips = [...new Set(properties.map((p) => p.zip!))]
      const zipCoords  = new Map<string, { lat: number; lng: number } | null>()

      for (const batch of chunk(uniqueZips, 10)) {
        for (const zip of batch) {
          zipCoords.set(zip, await geocodeZip(zip))
          await sleep(200)
        }
      }

      let geocoded = 0
      let skipped  = 0

      // Group by resolved coordinates so properties sharing a zip write in
      // one batched update instead of one sequential update per property.
      const idsByCoordsKey = new Map<string, { lat: number; lng: number; ids: string[] }>()
      for (const prop of properties) {
        const coords = zipCoords.get(prop.zip!)
        if (!coords) { skipped++; continue }
        const key = `${coords.lat},${coords.lng}`
        const group = idsByCoordsKey.get(key)
        if (group) group.ids.push(prop.id)
        else idsByCoordsKey.set(key, { lat: coords.lat, lng: coords.lng, ids: [prop.id] })
      }

      for (const { lat, lng, ids } of idsByCoordsKey.values()) {
        await supabase.from('properties').update({ lat, lng }).in('id', ids)
        geocoded += ids.length
      }

      return { geocoded, skipped }
    })

    const vendorsResult = await step.run('geocode-vendors', async (): Promise<{ geocoded: number; skipped: number }> => {
      const supabase = createServiceClient()
      const pageSize = 1000
      const vendors: { id: string; service_zip: string | null }[] = []
      for (let from = 0; ; from += pageSize) {
        const { data } = await supabase
          .from('vendors')
          .select('id, service_zip')
          .is('lat', null)
          .not('service_zip', 'is', null)
          .range(from, from + pageSize - 1)
        if (!data?.length) break
        vendors.push(...data)
        if (data.length < pageSize) break
      }

      if (!vendors.length) return { geocoded: 0, skipped: 0 }

      // LOW-4: vendors sharing a service zip resolve to the same coordinates —
      // geocode each unique zip once instead of once per vendor.
      const uniqueZips = [...new Set(vendors.map((v) => v.service_zip!))]
      const zipCoords  = new Map<string, { lat: number; lng: number } | null>()

      for (const batch of chunk(uniqueZips, 10)) {
        for (const zip of batch) {
          zipCoords.set(zip, await geocodeZip(zip))
          await sleep(200)
        }
      }

      let geocoded = 0
      let skipped  = 0

      // Group by resolved coordinates so vendors sharing a zip write in one
      // batched update instead of one sequential update per vendor.
      const idsByCoordsKey = new Map<string, { lat: number; lng: number; ids: string[] }>()
      for (const vendor of vendors) {
        const coords = zipCoords.get(vendor.service_zip!)
        if (!coords) { skipped++; continue }
        const key = `${coords.lat},${coords.lng}`
        const group = idsByCoordsKey.get(key)
        if (group) group.ids.push(vendor.id)
        else idsByCoordsKey.set(key, { lat: coords.lat, lng: coords.lng, ids: [vendor.id] })
      }

      for (const { lat, lng, ids } of idsByCoordsKey.values()) {
        await supabase.from('vendors').update({ lat, lng }).in('id', ids)
        geocoded += ids.length
      }

      return { geocoded, skipped }
    })

    return {
      properties: propertiesResult,
      vendors:    vendorsResult,
    }
  }
)
