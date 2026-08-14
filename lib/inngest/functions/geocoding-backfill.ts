import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { geocodeZip } from '@/lib/geocoding'
import { unwrapList } from '@/lib/supabase/unwrap'

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
// SCHEDULED, not only event-triggered. This function was registered, its event
// was declared in events.ts — and NOTHING IN THE CODEBASE EVER SENT THAT EVENT.
// It had therefore never run once. That was invisible precisely because a
// registered function with a declared event looks identical to a working one,
// and the symptom (properties with null lat/lng) surfaces as degraded
// auto-assign rather than as an error.
//
// 04:00 UTC is deliberately clear of the cron cluster documented in CLAUDE.md
// (09:00/09:30 Hospitable, 10:00 OwnerRez property diff, 11:00 OwnerRez
// reconciliation, 13:00-14:00 daily group), so a Mapbox-bound scan is not
// competing with the PMS syncs that create the rows it fixes.
//
// The event trigger stays: it is how ops tooling forces a run without waiting
// for the schedule.
export const geocodingBackfill = inngest.createFunction(
  {
    id: 'geocoding-backfill', name: 'Backfill Property & Vendor Geocodes', retries: 1,
    // One platform-wide scan at a time — see the cross-tenant note above.
    concurrency: { limit: 1, key: '"geocoding-backfill"' },
  },
  [
    { cron: '0 4 * * *' },
    { event: 'geocoding/backfill-requested' },
  ],
  async ({ step }) => {

    const propertiesResult = await step.run('geocode-properties', async (): Promise<{ geocoded: number; skipped: number }> => {
      const supabase = createServiceClient({ system: 'inngest:geocoding-backfill' })
      const pageSize = 1000
      const properties: { id: string; zip: string | null }[] = []
      for (let from = 0; ; from += pageSize) {
        const pageRes = await supabase
          .from('properties')
          .select('id, zip')
          .is('lat', null)
          .not('zip', 'is', null)
          .range(from, from + pageSize - 1)
        const data = unwrapList(pageRes, { site: 'inngest.geocoding-backfill.geocode-properties' })
        if (!data.length) break
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
      const supabase = createServiceClient({ system: 'inngest:geocoding-backfill' })
      const pageSize = 1000
      const vendors: { id: string; service_zip: string | null }[] = []
      for (let from = 0; ; from += pageSize) {
        const pageRes = await supabase
          .from('vendors')
          .select('id, service_zip')
          .is('lat', null)
          .not('service_zip', 'is', null)
          .range(from, from + pageSize - 1)
        const data = unwrapList(pageRes, { site: 'inngest.geocoding-backfill.geocode-vendors' })
        if (!data.length) break
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
