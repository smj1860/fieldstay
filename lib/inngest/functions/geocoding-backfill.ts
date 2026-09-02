import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { geocodeZip } from '@/lib/geocoding'
import { fetchAllRows } from '@/lib/inngest/paginate'

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}


type UngeocodedRow = { id: string; zip: string }

/**
 * LOW-4: rows sharing a zip code resolve to the same coordinates — geocode
 * each unique zip once instead of once per row, paced so a large backfill
 * doesn't burst Mapbox.
 */
async function resolveZipCoords(zips: string[]): Promise<Map<string, { lat: number; lng: number } | null>> {
  const zipCoords = new Map<string, { lat: number; lng: number } | null>()

  for (const batch of chunk(zips, 10)) {
    for (const zip of batch) {
      zipCoords.set(zip, await geocodeZip(zip))
      await sleep(200)
    }
  }

  return zipCoords
}

/**
 * Groups rows by their resolved coordinates so rows sharing a zip write in one
 * batched update instead of one update per row. `skipped` counts rows whose
 * zip did not resolve.
 */
function groupIdsByCoords(
  rows:      UngeocodedRow[],
  zipCoords: Map<string, { lat: number; lng: number } | null>,
): { groups: Array<{ lat: number; lng: number; ids: string[] }>; skipped: number } {
  const byCoordsKey = new Map<string, { lat: number; lng: number; ids: string[] }>()
  let skipped = 0

  for (const row of rows) {
    const coords = zipCoords.get(row.zip)
    if (!coords) { skipped++; continue }
    const key   = `${coords.lat},${coords.lng}`
    const group = byCoordsKey.get(key)
    if (group) group.ids.push(row.id)
    else byCoordsKey.set(key, { lat: coords.lat, lng: coords.lng, ids: [row.id] })
  }

  return { groups: [...byCoordsKey.values()], skipped }
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

    const propertiesResult = await step.run('geocode-properties', async () => {
      const supabase = createServiceClient({ system: 'inngest:geocoding-backfill' })

      // Paginated: this is a platform-wide scan, and an unbounded read would
      // truncate at max_rows and leave the rest unfixed forever.
      const properties = await fetchAllRows<{ id: string; zip: string | null }>(
        (from, to) => supabase
          .from('properties')
          .select('id, zip')
          .is('lat', null)
          .not('zip', 'is', null)
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'properties(geocoding-backfill)' },
      )
      if (!properties.length) return { geocoded: 0, skipped: 0 }

      const rows: UngeocodedRow[] = properties.map((p) => ({ id: p.id, zip: p.zip! }))
      const zipCoords           = await resolveZipCoords([...new Set(rows.map((r) => r.zip))])
      const { groups, skipped } = groupIdsByCoords(rows, zipCoords)

      let geocoded = 0
      for (const { lat, lng, ids } of groups) {
        await supabase.from('properties').update({ lat, lng }).in('id', ids)
        geocoded += ids.length
      }

      return { geocoded, skipped }
    })

    const vendorsResult = await step.run('geocode-vendors', async () => {
      const supabase = createServiceClient({ system: 'inngest:geocoding-backfill' })

      const vendors = await fetchAllRows<{ id: string; service_zip: string | null }>(
        (from, to) => supabase
          .from('vendors')
          .select('id, service_zip')
          .is('lat', null)
          .not('service_zip', 'is', null)
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'vendors(geocoding-backfill)' },
      )
      if (!vendors.length) return { geocoded: 0, skipped: 0 }

      const rows: UngeocodedRow[] = vendors.map((v) => ({ id: v.id, zip: v.service_zip! }))
      const zipCoords           = await resolveZipCoords([...new Set(rows.map((r) => r.zip))])
      const { groups, skipped } = groupIdsByCoords(rows, zipCoords)

      let geocoded = 0
      for (const { lat, lng, ids } of groups) {
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
