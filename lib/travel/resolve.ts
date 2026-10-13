import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import { tryUnwrapList } from '@/lib/supabase/unwrap'
import { routeConsecutiveLegs, type RoutedLeg } from '@/lib/travel/mapbox'
import {
  travelLegKey, hasCoordinates,
  type TravelLegMap, type TravelStop,
} from '@/lib/travel/estimate'

/**
 * Routed travel for a day's chain of stops: cache first, Mapbox second,
 * straight line last.
 *
 * ── The three-way split, and why the read path never fetches ──
 * `resolveChainTravel` is called by the overnight day planner and MAY spend a
 * Mapbox request. `lookupChainTravel` is called by anything on a request path
 * or a frequent cron (the cascade check runs 48 times a day) and NEVER does:
 * it reads what the planner already cached and otherwise falls back to the
 * straight line. Routing from a page render would put a third party's latency
 * in front of a PM, and routing from a half-hourly cron would spend a month's
 * API budget in a week.
 *
 * ── Staleness ──
 * A cached leg older than TRAVEL_CACHE_TTL_DAYS is re-fetched by the planner
 * but still USED by the read path. A six-month-old drive time between two
 * houses is a far better answer than a straight line, and the read path has
 * no way to refresh it anyway.
 */

/**
 * 90 days. Road networks change on the scale of construction seasons, and
 * these are durations with no traffic model in them, so there is nothing in a
 * cached row that goes off faster than that. Long enough that a property pair
 * is re-routed about four times a year.
 */
export const TRAVEL_CACHE_TTL_DAYS = 90

/**
 * Batch sizes for the cache round trips.
 *
 * An org-day's legs are far below either figure, but a `.in()` list and an
 * upsert body both travel in the URL or the request body, and the ceiling
 * that matters is the gateway's rather than PostgREST's max_rows. Chunking is
 * what keeps a 300-property org's night from becoming one oversized request
 * that fails whole rather than in part.
 */
const CACHE_READ_BATCH  = 400
const CACHE_WRITE_BATCH = 400

interface CacheRow {
  cache_key:  string
  minutes:    number
  miles:      number | string | null
  fetched_at: string
}

type ServiceClient = ReturnType<typeof createServiceClient>

/** Every consecutive leg across every chain, deduplicated, as cache keys. */
function legKeysFor(chains: readonly (readonly TravelStop[])[]): string[] {
  const keys = new Set<string>()
  for (const stops of chains) {
    for (let i = 0; i < stops.length - 1; i++) {
      const key = travelLegKey(stops[i]!, stops[i + 1]!)
      if (key !== null) keys.add(key)
    }
  }
  return [...keys]
}

interface CachedLeg extends RoutedLeg { fetchedAt: string }

/**
 * ONE read for every leg of every chain.
 *
 * Deliberately not a read per crew member: the whole org's night is a single
 * `.in('cache_key', keys)`, which is the shape unit/guardrails/n-plus-one-
 * loops.test.ts exists to enforce and which a per-chain helper would quietly
 * violate for every caller that loops.
 */
async function readCache(
  supabase: ServiceClient,
  orgId:    string,
  keys:     string[],
): Promise<Map<string, CachedLeg>> {
  const found = new Map<string, CachedLeg>()
  if (keys.length === 0) return found

  for (const batch of chunk(keys, CACHE_READ_BATCH)) {
    // Bounded by the key list the caller already holds, so the .in() array IS
    // the ceiling rather than a guess at one.
    const res = await supabase
      .from('travel_time_cache')
      .select('cache_key, minutes, miles, fetched_at')
      .eq('org_id', orgId)
      .in('cache_key', batch)
      .limit(batch.length)

    // tryUnwrapList, not unwrapList: a cache read that fails must degrade to
    // the straight-line estimate, not take the planner down with it.
    const rows = tryUnwrapList<CacheRow>(res, { site: 'lib.travel.resolve.readCache', orgId })
    if (!rows.ok) return found

    for (const row of rows.data) {
      found.set(row.cache_key, {
        minutes:   row.minutes,
        miles:     row.miles === null ? null : Number(row.miles),
        fetchedAt: row.fetched_at,
      })
    }
  }

  return found
}

function isStale(fetchedAt: string, now: number): boolean {
  const age = now - Date.parse(fetchedAt)
  return !Number.isFinite(age) || age > TRAVEL_CACHE_TTL_DAYS * 86_400_000
}

/** Splits a key back into its two rounded coordinate pairs for the insert. */
function coordsFromKey(key: string): {
  origin_lat: number; origin_lng: number; dest_lat: number; dest_lng: number
} | null {
  const [from, to] = key.split('>')
  const a = from?.split(',').map(Number)
  const b = to?.split(',').map(Number)
  if (!a || !b || a.length !== 2 || b.length !== 2) return null
  if (![...a, ...b].every((n) => Number.isFinite(n))) return null
  return { origin_lat: a[0]!, origin_lng: a[1]!, dest_lat: b[0]!, dest_lng: b[1]! }
}

async function writeCache(
  supabase: ServiceClient,
  orgId:    string,
  legs:     ReadonlyMap<string, RoutedLeg>,
): Promise<void> {
  const fetchedAt = new Date().toISOString()
  const rows = [...legs.entries()].flatMap(([cache_key, leg]) => {
    const coords = coordsFromKey(cache_key)
    if (!coords) return []
    return [{
      org_id: orgId, cache_key, ...coords,
      minutes: leg.minutes, miles: leg.miles, provider: 'mapbox-matrix',
      fetched_at: fetchedAt,
    }]
  })

  if (rows.length === 0) return

  for (const batch of chunk(rows, CACHE_WRITE_BATCH)) {
    // UPSERT on the unique (org_id, cache_key): a re-route of a pair we
    // already hold must REPLACE it, which is the whole mechanism behind the
    // TTL. So not ignoreDuplicates, unlike the notification batch, where a
    // second delivery of the same row carries no new information.
    const { error } = await supabase
      .from('travel_time_cache')
      .upsert(batch, { onConflict: 'org_id,cache_key' })

    // Logged, never thrown: the caller has its routed figures in hand
    // already, and failing the step would discard them over a cache write.
    if (error) {
      console.warn('[travel.resolve] cache write failed', {
        orgId, rows: batch.length, error: error.message,
      })
    }
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * READ-ONLY. Cached routed legs for every chain, and nothing else.
 *
 * Safe on a request path and in a frequent cron. Spends no routing request
 * under any circumstances, so a caller that runs 48 times a day cannot turn
 * into 48 times a day of API spend. Legs it has no row for are simply absent
 * from the map, and chainTravel()/planDay()/rankCascadeRisk() fall back to
 * the straight line and label it.
 */
export async function lookupTravelMinutes(
  orgId:  string,
  chains: readonly (readonly TravelStop[])[],
): Promise<TravelLegMap> {
  const keys = legKeysFor(chains)
  if (keys.length === 0) return new Map()

  const supabase = createServiceClient({ system: 'inngest:travel-lookup' })
  return readCache(supabase, orgId, keys)
}

/**
 * The planner's path: fill cache misses and stale rows from the router, store
 * them, and return every leg it now knows.
 *
 * Idempotent the way an Inngest step needs: a retry re-reads the cache, finds
 * what the first attempt wrote, and makes no further request.
 */
export async function resolveTravelMinutes(
  orgId:  string,
  chains: readonly (readonly TravelStop[])[],
): Promise<TravelLegMap> {
  const keys = legKeysFor(chains)
  if (keys.length === 0) return new Map()

  const supabase = createServiceClient({ system: 'inngest:day-planner' })
  const cached   = await readCache(supabase, orgId, keys)
  const now      = Date.now()

  const needed = new Set(keys.filter((key) => {
    const hit = cached.get(key)
    return !hit || isStale(hit.fetchedAt, now)
  }))

  if (needed.size === 0) return cached

  // Routed per CHAIN, not per leg: the Matrix API prices a request by the
  // call rather than by the cell, so one request covers a crew member's whole
  // day however many stops it holds. A chain with nothing missing is skipped
  // entirely, which is what makes the second night cheap.
  const routed = new Map<string, RoutedLeg>()

  for (const stops of chains) {
    const chainKeys = legKeysFor([stops])
    if (!chainKeys.some((key) => needed.has(key))) continue

    const legs = await routeConsecutiveLegs(stops.filter(hasCoordinates))
    for (const [key, leg] of legs) routed.set(key, leg)
  }

  if (routed.size === 0) return cached

  await writeCache(supabase, orgId, routed)

  const merged = new Map(cached)
  const fetchedAt = new Date(now).toISOString()
  for (const [key, leg] of routed) merged.set(key, { ...leg, fetchedAt })
  return merged
}
