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
