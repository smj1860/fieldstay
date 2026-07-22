import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDashboardPushNotifications } from '@/lib/hooks/use-dashboard-push-notifications'

// A valid base64url string so urlBase64ToUint8Array doesn't throw on atob().
const VAPID_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa40HI8DLzZFAK6oPPo6M-l8ZAQCM'

interface MockRegistration {
  pushManager: {
    getSubscription: ReturnType<typeof vi.fn>
    subscribe: ReturnType<typeof vi.fn>
  }
}

function makeMockRegistration(): MockRegistration {
  return {
    pushManager: {
      getSubscription: vi.fn(),
      subscribe: vi.fn(),
    },
  }
}

function makeMockSubscription(withKeys = true) {
  return {
    toJSON: () => ({
      endpoint: 'https://push.example.com/abc',
      keys: withKeys ? { p256dh: 'p256dh-value', auth: 'auth-value' } : undefined,
    }),
  }
}

function stubServiceWorkerSupport(registerMock: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register: registerMock },
    configurable: true,
  })
  Object.defineProperty(window, 'PushManager', {
    value: function PushManager() {},
    configurable: true,
  })
}

function removeServiceWorkerSupport() {
  Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true })
  Object.defineProperty(window, 'PushManager', { value: undefined, configurable: true })
}

function stubNotification(permission: NotificationPermission, requestResult?: NotificationPermission) {
  const requestPermission = vi.fn().mockResolvedValue(requestResult ?? permission)
  vi.stubGlobal('Notification', { permission, requestPermission })
}

describe('useDashboardPushNotifications', () => {
  const originalVapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY

  beforeEach(() => {
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = VAPID_KEY
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    removeServiceWorkerSupport()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = originalVapidKey
  })

  it('does nothing when the browser has no serviceWorker/PushManager support', async () => {
    removeServiceWorkerSupport()

    const { result } = renderHook(() => useDashboardPushNotifications())

    expect(result.current.notifVisible).toBe(false)

    // enableNotifications() is a no-op without a registration to hang off.
    await act(async () => {
      await result.current.enableNotifications()
    })
    expect(result.current.notifVisible).toBe(false)
  })

  it('registers the service worker and shows the prompt when permission is "default" with no existing subscription', async () => {
    const reg = makeMockRegistration()
    reg.pushManager.getSubscription.mockResolvedValue(null)
    const registerMock = vi.fn().mockResolvedValue(reg)
    stubServiceWorkerSupport(registerMock)
    stubNotification('default')

    const { result } = renderHook(() => useDashboardPushNotifications())

    await waitFor(() => expect(result.current.notifVisible).toBe(true))
    expect(registerMock).toHaveBeenCalledWith('/sw.js')
  })

  it('auto-subscribes without showing the prompt when permission is already "granted"', async () => {
    const reg = makeMockRegistration()
    reg.pushManager.getSubscription.mockResolvedValue(null)
    reg.pushManager.subscribe.mockResolvedValue(makeMockSubscription())
    const registerMock = vi.fn().mockResolvedValue(reg)
    stubServiceWorkerSupport(registerMock)
    stubNotification('granted')

    renderHook(() => useDashboardPushNotifications())

    await waitFor(() => expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1))
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/dashboard/push-subscribe',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          endpoint: 'https://push.example.com/abc',
          p256dh: 'p256dh-value',
          auth: 'auth-value',
        }),
      })
    )
  })

  it('does not prompt or subscribe again when a push subscription already exists', async () => {
    const reg = makeMockRegistration()
    reg.pushManager.getSubscription.mockResolvedValue(makeMockSubscription())
    const registerMock = vi.fn().mockResolvedValue(reg)
    stubServiceWorkerSupport(registerMock)
    stubNotification('granted')

    const { result } = renderHook(() => useDashboardPushNotifications())

    await waitFor(() => expect(reg.pushManager.getSubscription).toHaveBeenCalledTimes(1))
    expect(result.current.notifVisible).toBe(false)
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled()
  })

  it('does not prompt when permission was already "denied"', async () => {
    const reg = makeMockRegistration()
    reg.pushManager.getSubscription.mockResolvedValue(null)
    const registerMock = vi.fn().mockResolvedValue(reg)
    stubServiceWorkerSupport(registerMock)
    stubNotification('denied')

    const { result } = renderHook(() => useDashboardPushNotifications())

    await waitFor(() => expect(registerMock).toHaveBeenCalled())
    expect(result.current.notifVisible).toBe(false)
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled()
  })

  it('logs and swallows a registration failure instead of throwing', async () => {
    const registerMock = vi.fn().mockRejectedValue(new Error('registration failed'))
    stubServiceWorkerSupport(registerMock)
    stubNotification('default')

    renderHook(() => useDashboardPushNotifications())

    await waitFor(() => expect(console.error).toHaveBeenCalledWith(
      '[sw] dashboard registration failed:',
      expect.any(Error)
    ))
  })

  it('enableNotifications() requests permission, hides the prompt, and subscribes on grant', async () => {
    const reg = makeMockRegistration()
    reg.pushManager.getSubscription.mockResolvedValue(null)
    reg.pushManager.subscribe.mockResolvedValue(makeMockSubscription())
    const registerMock = vi.fn().mockResolvedValue(reg)
    stubServiceWorkerSupport(registerMock)
    stubNotification('default', 'granted')

    const { result } = renderHook(() => useDashboardPushNotifications())
    await waitFor(() => expect(result.current.notifVisible).toBe(true))

    await act(async () => {
      await result.current.enableNotifications()
    })

    expect(result.current.notifVisible).toBe(false)
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1)
  })

  it('enableNotifications() hides the prompt without subscribing when permission is refused', async () => {
    const reg = makeMockRegistration()
    reg.pushManager.getSubscription.mockResolvedValue(null)
    const registerMock = vi.fn().mockResolvedValue(reg)
    stubServiceWorkerSupport(registerMock)
    stubNotification('default', 'denied')

    const { result } = renderHook(() => useDashboardPushNotifications())
    await waitFor(() => expect(result.current.notifVisible).toBe(true))

    await act(async () => {
      await result.current.enableNotifications()
    })

    expect(result.current.notifVisible).toBe(false)
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled()
  })

  it('does not throw if the browser is unmounted before async registration resolves', async () => {
    const reg = makeMockRegistration()
    reg.pushManager.getSubscription.mockResolvedValue(null)
    const registerMock = vi.fn().mockResolvedValue(reg)
    stubServiceWorkerSupport(registerMock)
    stubNotification('default')

    const { unmount } = renderHook(() => useDashboardPushNotifications())
    expect(() => unmount()).not.toThrow()

    await act(async () => {
      await Promise.resolve()
    })
  })
})
