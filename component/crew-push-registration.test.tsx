import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// A failed push registration was silent AND permanent.
//
// `fetch` resolves on a 4xx/5xx rather than rejecting, and the response was
// discarded — so a 500 from /api/crew/push-subscribe, or a 401 from an expired
// session, looked exactly like success. The catch in enableNotifications()
// could not fire for it, the same shape as a try/catch around a bare awaited
// PostgREST builder.
//
// What made it permanent is the pair: pushManager.subscribe() had ALREADY
// created the browser-local subscription before the POST ran, so the next
// mount's getSubscription() found it and took an early return. The browser
// thinks it is subscribed; the server has no row; nothing ever retries. Push is
// how a crew member learns they have a new assignment — or that one was
// cancelled and they should not drive out.
//
// The route upserts on (crew_member_id, endpoint), so re-sending is a cheap
// no-op. That is what makes the self-heal safe.
// ============================================================================

const reportError = vi.fn()
vi.mock('@/lib/observability/report-error', () => ({ reportError: (...a: unknown[]) => reportError(...a) }))

import { syncSubscriptionToServer } from '@/app/crew/crew-shell'

/**
 * `keys: null` means "the browser handed back a subscription with no keys".
 * Deliberately NOT an optional parameter defaulting to the valid keys —
 * passing `undefined` explicitly selects the default value in JS, so that
 * shape silently tested the happy path instead of the missing-keys one.
 */
function subscription(keys: Record<string, string> | null = { p256dh: 'p', auth: 'a' }) {
  return {
    toJSON: () => ({ endpoint: 'https://push.example/abc', keys: keys ?? undefined }),
  } as unknown as PushSubscription
}

describe('crew push registration — a failed POST is not treated as success', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('throws on a server error instead of resolving quietly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))

    await expect(syncSubscriptionToServer(subscription())).rejects.toThrow(/500/)
  })

  // The session-expiry case. Indistinguishable from success before this, and
  // the one most likely to hit a crew member who leaves the PWA open for days.
  it('throws on an auth failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))

    await expect(syncSubscriptionToServer(subscription())).rejects.toThrow(/401/)
  })

  // Previously `if (!json.keys) return` — a silent success for a subscription
  // that could never receive anything.
  it('throws rather than silently sending nothing when the keys are missing', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(syncSubscriptionToServer(subscription(null))).rejects.toThrow(/encryption keys/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends the endpoint and both keys on the happy path', async () => {
    const fetchSpy = vi.fn(async () => new Response('{"success":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await syncSubscriptionToServer(subscription())

    expect(fetchSpy).toHaveBeenCalledWith('/api/crew/push-subscribe', expect.objectContaining({ method: 'POST' }))
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ endpoint: 'https://push.example/abc', p256dh: 'p', auth: 'a' })
  })
})
