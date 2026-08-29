// Cache version — bump both on any change to what gets cached, so
// `activate` cleans up the old entries instead of leaving them orphaned.
const SHELL_CACHE     = 'fieldstay-shell-v4'
const ASSET_CACHE     = 'fieldstay-assets-v4'
const OFFLINE_URL     = '/offline.html'
const CURRENT_CACHES  = [SHELL_CACHE, ASSET_CACHE]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.add(OFFLINE_URL))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => !CURRENT_CACHES.includes(key))
          .map((key) => caches.delete(key))
      )
    )
  )
  self.clients.claim()
})

// Paths whose pages may be cached and served offline.
//
// THIS WORKER IS REGISTERED AT ROOT SCOPE, FROM THREE PLACES: app/crew/
// crew-shell.tsx, app/work-orders/[token]/register-service-worker.tsx, and —
// on every dashboard page load, before any notification opt-in —
// lib/hooks/use-dashboard-push-notifications.ts. `register('/sw.js')` with no
// options scopes to '/', so it controls the entire origin.
//
// Until 2026-08-21 the navigate handler below had no path test at all: it
// cached EVERY successful navigation and served it back whenever the network
// failed. On the crew PWA and the vendor work-order page that is the intended
// feature. On the PM dashboard it was an accident of the push registration,
// and it meant a PM at a property with no signal opened /ops and got
// yesterday's board rendered as current, with nothing saying otherwise.
// Cache-Control: no-store does not prevent it — the Cache API is not the HTTP
// cache and cache.put() ignores those headers.
//
// So: an explicit allowlist. A path not on it is never cached, and when the
// network fails it gets the offline PAGE rather than a stale copy of itself —
// "you are offline" is honest, "here is Tuesday's data" is not.
//
// /maintenance is deliberately ABSENT. It is the next surface to go offline
// (see docs/INSPECTIONS_SPEC.md §8), but it has no local store behind it yet,
// so allowlisting it now would ship the exact staleness this change removes,
// just narrowed to one page.
//
// ⚠️ SHARPENED 2026-08-22. This used to say "it goes in when the offline
// foundation lands", and phase 2a has now landed the foundation — the Dexie
// cache (lib/dexie/dashboard/schema.ts), its lifecycle and the outbox. It still
// must NOT go in, because "the foundation exists" was never the real condition.
//
// What this worker caches is the SERVER-RENDERED HTML of a page. /maintenance
// is a Server Component that renders its data on the server, so serving it from
// cache serves last Tuesday's board no matter how current the IndexedDB copy
// beside it is. A local store only helps once the page READS from it on the
// client, which is phase 3's tablet UI.
//
// The condition is therefore: /maintenance goes in when it renders from the
// local cache, not when the local cache exists.
//
// ✅ MET 2026-08-23, FOR EXACTLY ONE ROUTE. The inspection fill screen
// (app/(dashboard)/maintenance/inspections/[id]/) is a shell: its Server
// Component resolves three ids and renders nothing else, and every value on the
// page comes from Dexie via useLiveQuery. The HTML cached here is therefore a
// frame with no facts in it, which is the only kind that cannot go stale.
//
// ✅ THE LIST JOINED IT 2026-08-23, when starting a walk became possible with
// no signal (20260823053931). It had been excluded on the grounds that it was a
// Server Component rendering its rows on the server — true then, and the reason
// it was rewritten: if you can START an inspection offline you must be able to
// SEE it, or a PM begins a walk, backgrounds the app, and finds an empty list
// with no route back to the inspection they are halfway through. Both pages now
// render from Dexie and hold no server-rendered data.
//
// ✅ THE BOARD ITSELF MET THE CONDITION, 2026-08-28. maintenance-board.tsx now
// reads work_orders through useLiveQuery (merge-offline-work-orders.ts),
// overlaid onto the Server Component's props — see warm-maintenance-board.ts.
// So /maintenance now qualifies by the same rule the inspection routes did:
// the HTML it serves offline carries no server-rendered rows of its own,
// only a shell the client repopulates from Dexie.
//
// It is added to OFFLINE_EXACT_PATHS, a SEPARATE list from OFFLINE_PATHS
// below, and that separation is load-bearing, not stylistic. OFFLINE_PATHS'
// matching turns a bare entry into a PREFIX (`p + '/'`), which is exactly
// right for '/maintenance/inspections' — the fill screen lives under it and
// must be covered too — and exactly wrong for the board: '/maintenance/[id]'
// (a single work order's detail page) starts with '/maintenance/' and is
// STILL server-rendered, so prefix-matching '/maintenance' would silently
// start caching and replaying a stale copy of it — the precise staleness bug
// this file's history (see above) already shipped and fixed once for the
// board itself. Exact-only closes that off structurally rather than by
// remembering not to add a trailing-slash variant.
const OFFLINE_PATHS = [
  '/crew',          // the crew PWA — offline is its whole point
  '/work-orders/',  // vendor token pages, cached so a hard reload survives no signal
  '/maintenance/inspections',  // the list — renders from Dexie, so a walk can be STARTED offline
  '/maintenance/inspections/', // the fill screen — renders from Dexie
]

/** Checked by EXACT match only — see the comment above on why. A Set, so the
 *  membership check below is .has() rather than an O(n) Array.includes(). */
const OFFLINE_EXACT_PATHS = new Set([
  '/maintenance',  // the board — renders from Dexie now; a single work order's detail page must NOT be swept in
])

function isOfflineCapable(pathname) {
  if (OFFLINE_EXACT_PATHS.has(pathname)) return true
  return OFFLINE_PATHS.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : p + '/'))
}

// App-shell caching — this is the piece that makes "open the installed
// app with no signal" actually work, as opposed to just "the data you'd
// already loaded is in IndexedDB." Two request classes only; everything
// else (API routes, Server Actions, RSC payloads) passes straight
// through untouched — this worker has no opinion about them.
self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Page navigations — network-first so a signal always gets the freshest
  // (auth-gated, per-request) HTML; cache fallback for the same URL when
  // offline; a generic offline page as the last resort for a URL that was
  // never successfully visited on this device.
  if (request.mode === 'navigate') {
    // Outside the allowlist: never cache, and never serve a cached page. Still
    // answer an offline navigation with the offline page rather than the
    // browser's own error — the point is to stop serving STALE CONTENT, not to
    // stop being a PWA.
    if (!isOfflineCapable(url.pathname)) {
      event.respondWith(
        fetch(request).catch(() => caches.match(OFFLINE_URL))
      )
      return
    }

    event.respondWith(
      fetch(request)
        .then((response) => {
          // Only cache a real page. Caching a redirect to /login (session
          // expired mid-flight) would strand the crew member on a login screen
          // at a property with no signal, with no way to get past it.
          if (response.ok && !response.redirected) {
            const copy = response.clone()
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(() =>
          // ignoreVary is load-bearing, not defensive. Next.js serves page
          // documents with `Vary: RSC, Next-Router-State-Tree, ...`, and a
          // navigation request carries none of those headers — so a strict
          // match against an entry stored by warmCrewRouteCache's plain
          // fetch() MISSES, and every warmed route would fall through to the
          // offline page as if it had never been warmed at all.
          caches.match(request, { ignoreVary: true })
            .then((cached) => cached ?? caches.match(OFFLINE_URL))
        )
    )
    return
  }

  // Next.js build output under /_next/static/ is content-hashed and
  // immutable — a given URL never changes what it serves, so cache-first
  // is always correct here (a new deploy ships new hashed URLs, it never
  // reuses an old one with different content).
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached
        return fetch(request).then((response) => {
          const copy = response.clone()
          caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy))
          return response
        })
      })
    )
  }
})

self.addEventListener('push', (event) => {
  if (!event.data) return

  let data = {}
  try { data = event.data.json() } catch { return }

  const target = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//')
    ? data.url
    : '/crew'

  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title ?? 'FieldStay', {
      body:    data.body  ?? 'You have a new assignment.',
      data:    { url: target },
      vibrate: [200, 100, 200],
    }),
    // Warm the page this notification points at, WITH THE APP CLOSED.
    //
    // The in-app warm (lib/dexie/sync/warm-routes.ts) only runs while the crew
    // member has the app open. A turnover assigned overnight would not be
    // cached by it until they next opened the app — and if that first open
    // happens at the property, there is no signal to fetch it with.
    //
    // A push wakes the service worker without the app running, so the document
    // for the assignment being announced can be cached at the moment it is
    // announced. By the time they tap the notification at the house, it is
    // already on the device.
    warmRoute(target),
  ]))
})

/**
 * Fetches one page document into the shell cache. Best-effort by design: a
 * failed warm must never stop a notification from being shown.
 *
 * Skips non-2xx and redirects for the same reason the fetch handler does —
 * caching a redirect to /login would strand a crew member on a login screen at
 * a property with no signal, with no way past it.
 */
async function warmRoute(path) {
  try {
    const res = await fetch(path, { credentials: 'same-origin' })
    if (!res.ok || res.redirected) return
    const cache = await caches.open(SHELL_CACHE)
    await cache.put(path, res.clone())
  } catch {
    // Offline, or the session expired — the in-app warm will retry.
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const rawUrl = event.notification.data?.url ?? '/crew'
  // Only allow same-origin paths — reject absolute URLs and protocol-relative
  const url = rawUrl.startsWith('/') && !rawUrl.startsWith('//') ? rawUrl : '/crew'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ((client.url.includes('/crew') || client.url.includes('/properties') || client.url.includes('/turnovers')) && 'focus' in client) {
          return client.focus()
        }
      }
      if (clients.openWindow) return clients.openWindow(url)
    })
  )
})
