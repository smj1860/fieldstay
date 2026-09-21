import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// "Skipping costs nothing — the next online mount re-sends" was only true if
// the app actually REMOUNTS once connectivity returns. A PWA is designed to
// stay open across connectivity blips without remounting at all, so a device
// that goes offline before registerAndSyncPush() runs, then regains
// connectivity within the SAME still-open session, previously never
// re-triggered a sync at all — the server-side row silently went stale (or
// was never created) for the rest of that session, with nothing anywhere
// signalling it.
// ============================================================================

let onlineMock = false
vi.mock('@/lib/dexie/net', () => ({ isOnline: () => onlineMock }))

import { registerAndSyncPush } from '@/lib/push/subscribe-client'

function fakeSubscription() {
  return {
    toJSON: () => ({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p', auth: 'a' },
    }),
  } as unknown as PushSubscription
}

function stubServiceWorker(existing: PushSubscription | null) {
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => existing),
      subscribe: vi.fn(async () => fakeSubscription()),
    },
  } as unknown as ServiceWorkerRegistration

  vi.stubGlobal('navigator', {
    serviceWorker: { register: vi.fn(async () => registration) },
  })
  return registration
}

/**
 * Captures whatever the code under test registers for 'online' instead of
 * relying on real DOM event dispatch — `globalThis` is the REAL global
 * object even under `vi.stubGlobal`/`vi.unstubAllGlobals()` (those only
 * swap named properties like `navigator`/`fetch`), so a listener added via
 * the genuine `addEventListener` in one test would otherwise leak into
 * every test after it.
 */
let onlineListeners: Array<() => void> = []

beforeEach(() => {
  vi.unstubAllGlobals()
  onlineMock = true
  onlineListeners = []
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"success":true}', { status: 200 })))
  vi.stubGlobal('Notification', { permission: 'granted' })
  vi.stubGlobal('addEventListener', (event: string, cb: () => void) => {
    if (event === 'online') onlineListeners.push(cb)
  })
})

function fireOnline() {
  for (const cb of onlineListeners) cb()
}

describe('registerAndSyncPush — offline at mount, then reconnecting in the SAME session', () => {
  it('resyncs on the "online" event when the app was offline at mount, with no remount', async () => {
    onlineMock = false
    const existing = fakeSubscription()
    stubServiceWorker(existing)
    const fetchSpy = vi.mocked(globalThis.fetch)

    await registerAndSyncPush('/api/dashboard/push-subscribe')

    // Offline at mount — the sync must not have run yet.
    expect(fetchSpy).not.toHaveBeenCalled()

    // Connectivity returns WITHOUT a remount — nothing calls
    // registerAndSyncPush() again; only the browser's own event fires.
    fireOnline()
    // The listener's own syncPushSubscription() call is async (a fetch); let
    // its microtasks flush.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0]!
    expect(JSON.parse(init!.body as string)).toMatchObject({ endpoint: 'https://push.example/abc' })
  })

  it('syncs immediately, with no listener needed, when already online at mount', async () => {
    onlineMock = true
    const existing = fakeSubscription()
    stubServiceWorker(existing)
    const fetchSpy = vi.mocked(globalThis.fetch)

    await registerAndSyncPush('/api/dashboard/push-subscribe')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not resync on "online" when there was no existing subscription to begin with', async () => {
    onlineMock = false
    stubServiceWorker(null)
    const fetchSpy = vi.mocked(globalThis.fetch)

    // No existing subscription and permission not yet granted -> shouldPrompt,
    // no subscribe attempt at all.
    vi.stubGlobal('Notification', { permission: 'default' })
    const result = await registerAndSyncPush('/api/dashboard/push-subscribe')
    expect(result.shouldPrompt).toBe(true)

    fireOnline()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
