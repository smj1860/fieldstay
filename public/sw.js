// Cache version — bump both on any change to what gets cached, so
// `activate` cleans up the old entries instead of leaving them orphaned.
const SHELL_CACHE     = 'fieldstay-shell-v1'
const ASSET_CACHE     = 'fieldstay-assets-v1'
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
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
          return response
        })
        .catch(() =>
          caches.match(request).then((cached) => cached ?? caches.match(OFFLINE_URL))
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

  event.waitUntil(
    self.registration.showNotification(data.title ?? 'FieldStay', {
      body:    data.body  ?? 'You have a new assignment.',
      data:    { url: data.url ?? '/crew' },
      vibrate: [200, 100, 200],
    })
  )
})

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
