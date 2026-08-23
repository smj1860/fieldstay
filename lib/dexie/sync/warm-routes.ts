// lib/dexie/sync/warm-routes.ts
//
// PRE-CACHES the crew app's per-assignment page documents while the device
// still has signal.
//
// THE FAILURE THIS EXISTS FOR
//
// sw.js caches a page document only when that exact URL has been successfully
// navigated to. `/crew` therefore gets cached the first time the app is opened
// — it is the manifest's start_url — but `/crew/turnovers/<uuid>` does not,
// because that URL has never been visited until the moment the crew member
// taps it.
//
// Which is precisely the moment they are standing at the property with no
// service. Everything they need is already in IndexedDB, and the app still
// shows them the offline page, because the one thing missing is the HTML
// document for a route whose content is entirely client-rendered from that
// same IndexedDB.
//
// So after every successful resync — which is exactly when we know the
// assignment scope AND that the network is up — we fetch each assigned
// turnover's and work order's page URL and put it in the shell cache. The tap
// at the house then hits cache instead of the network.
//
// Deliberately best-effort: a warm failure must never fail a sync. The sync is
// what makes the DATA available offline; this only makes the SHELL available,
// and a device that misses a warm is no worse off than before this existed.

import { getDexieDb } from '../schema'
import { ROUTE_WARM_TIMEOUT_MS } from '@/lib/http/timeout'
import { SHELL_CACHE } from '@/lib/pwa/cache-names'

/**
 * Ceiling on how many documents one warm pass fetches.
 *
 * Each is a real HTTP request for a server-rendered page, so an unbounded pass
 * over a long-tenured cleaner's whole assignment history would be a request
 * storm on every sync. The crew home screen only surfaces a 7-day window
 * anyway, so warming far beyond that buys nothing.
 */
export const WARM_ROUTE_LIMIT = 20

/**
 * How far ahead to warm. Matches the crew home screen's own horizon, plus a
 * day of slack so a turnover does not fall out of the cache the morning it
 * becomes visible.
 */
const WARM_HORIZON_DAYS = 8

function canWarm(): boolean {
  // `caches` is absent in Node (tests, SSR) and in browsers without the Cache
  // API. navigator.onLine false-negatives are rare and only cost a skipped
  // warm, which the next sync repeats.
  if (typeof caches === 'undefined' || typeof fetch === 'undefined') return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  return true
}

/**
 * The routes worth warming: the crew member's near-term turnovers and their
 * open work orders, plus the app shell itself.
 */
async function collectRoutes(userId: string): Promise<string[]> {
  const db = getDexieDb(userId)

  const horizon = new Date(Date.now() + WARM_HORIZON_DAYS * 86_400_000)
    .toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)

  const turnovers = (await db.turnovers.toArray())
    .filter((t) =>
      t.status !== 'completed' &&
      t.status !== 'cancelled' &&
      t.checkout_datetime >= today + 'T00:00:00' &&
      t.checkout_datetime <= horizon + 'T23:59:59'
    )
    .sort((a, b) => a.checkout_datetime.localeCompare(b.checkout_datetime))

  const workOrders = await db.crew_work_orders.toArray()

  return [
    // The start_url. Already cached by any successful visit, but warming it
    // costs one request and removes the assumption.
    '/crew',
    ...turnovers.map((t) => `/crew/turnovers/${t.id}`),
    ...workOrders.map((w) => `/crew/work-orders/${w.id}`),
  ].slice(0, WARM_ROUTE_LIMIT)
}

/**
 * Fetches and caches the crew app's per-assignment documents.
 *
 * Never throws. Called from fullCrewResync after every entity has landed.
 */
export async function warmCrewRouteCache(userId: string): Promise<number> {
  if (!canWarm()) return 0

  try {
    const routes = await collectRoutes(userId)
    const cache  = await caches.open(SHELL_CACHE)

    let warmed = 0
    for (const route of routes) {
      try {
        // Same-origin credentialed: these pages are auth-gated, and an
        // uncredentialed fetch would cache a login redirect — which is worse
        // than caching nothing, because it would then be SERVED at the house.
        const res = await fetch(route, {
          credentials: 'same-origin',
          // Bounded: this rides on the tail of a sync, over the marginal
          // connection the whole feature exists for. A hang here would stall
          // the sync rather than merely skip a warm.
          signal: AbortSignal.timeout(ROUTE_WARM_TIMEOUT_MS),
        })

        // Only cache a real page. A 3xx to /login or a 5xx cached here is a
        // trap that outlives the outage that produced it.
        if (!res.ok || res.redirected) continue

        await cache.put(route, res.clone())
        warmed++
      } catch {
        // One route failing is not a reason to abandon the rest.
      }
    }
    return warmed
  } catch (err) {
    console.warn('[warmRoutes] route cache warm failed (non-fatal):', err)
    return 0
  }
}
