// lib/push/subscribe-client.ts
// ============================================================================
// Browser-side push subscription, shared by the crew PWA and the PM dashboard.
//
// WHY SHARED RATHER THAN TWO COPIES
//
// There were two, and they drifted. The crew copy (app/crew/crew-shell.tsx) was
// hardened over time; the dashboard copy
// (lib/hooks/use-dashboard-push-notifications.ts) was written from the same
// starting point and never got any of the fixes:
//
//   1. `if (existing) return` — a local browser subscription is not evidence
//      the SERVER has the row. Those are two systems and the POST between them
//      is exactly the step that can fail. Crew stopped returning early and
//      re-sends instead; the dashboard still returned.
//   2. `if (!json.keys) return` — silent success for a subscription that can
//      never receive anything. Crew throws; the dashboard returned.
//   3. The fetch result was discarded entirely, so a 403 or a 500 from the
//      route was indistinguishable from success. Crew checks res.ok.
//
// The measured consequence: push_subscriptions held ONE row on 2026-08-21 —
// crew — and zero PM rows, ever. All three registrations share one root-scoped
// service worker, so they share one PushManager subscription; on a device where
// the crew PWA subscribed first, `existing` was truthy and the dashboard
// returned before ever calling its route. No error, because the code never got
// far enough to have one.
//
// Both surfaces now call the same two functions, so the next fix lands once.
// ============================================================================

import { isOnline } from '@/lib/dexie/net'
import { PUSH_SUBSCRIBE_TIMEOUT_MS } from '@/lib/http/timeout'

/** Where a subscription for this surface is registered server-side. */
export type PushSubscribeEndpoint =
  | '/api/crew/push-subscribe'
  | '/api/dashboard/push-subscribe'

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = globalThis.atob(base64)
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
}

/**
 * Sends a subscription to its route.
 *
 * Both routes upsert — crew on (crew_member_id, endpoint), dashboard on
 * (user_id, endpoint) — so re-sending one the server already has is a cheap
 * no-op. That is what makes it safe to call on every mount, and it is what
 * lets a registration whose POST failed heal itself on the next app open.
 *
 * The two rows are independent by design: a person who is both a crew member
 * and a PM gets one row of each for the same device endpoint. Nothing
 * double-sends as a result — every send path filters on `crew_member_id` OR
 * `user_id`, never on org_id alone (verified across sendPushToUser,
 * notify-assignment-gap, flagged-turnover-wo and the assignCrew action).
 */
export async function syncPushSubscription(
  endpoint: PushSubscribeEndpoint,
  sub:      PushSubscription,
): Promise<void> {
  const json = sub.toJSON()

  // Throw, never return quietly. A subscription with no keys cannot be
  // encrypted to, so storing it would be recording a device that can never be
  // reached — the failure would surface later as "push doesn't work" with no
  // trace of why.
  if (!json.keys?.p256dh || !json.keys.auth) {
    throw new Error('Push subscription is missing its encryption keys')
  }

  const res = await fetch(endpoint, {
    // Without this the promise never settles on a dead connection, and the
    // mount handler awaiting it hangs with it. Giving up is cheap: the routes
    // upsert, so the next app open re-sends.
    signal:  AbortSignal.timeout(PUSH_SUBSCRIBE_TIMEOUT_MS),
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      endpoint: json.endpoint,
      p256dh:   json.keys.p256dh,
      auth:     json.keys.auth,
    }),
  })

  if (!res.ok) {
    throw new Error(`${endpoint} failed with ${res.status}`)
  }
}

/**
 * Creates a browser subscription if there is not one already, and registers it
 * with the server either way.
 *
 * `pushManager.subscribe()` returns the EXISTING subscription when one is
 * already present for the same applicationServerKey rather than erroring, so
 * this is safe to call unconditionally — but it is still called only after a
 * permission check, because subscribing is what triggers the prompt.
 */
export async function subscribeToPush(
  reg:      ServiceWorkerRegistration,
  endpoint: PushSubscribeEndpoint,
): Promise<void> {
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly:      true,
    applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
  })
  await syncPushSubscription(endpoint, sub)
}

/**
 * The whole on-mount flow: register the worker, then make sure the server knows
 * about this device.
 *
 * Returns the registration so callers can hold it for a later opt-in, and
 * whether a permission prompt is still worth showing.
 *
 * The `existing` branch is gated on isOnline() because these are PWAs expected
 * to be offline: without it every app open in a dead zone throws here and
 * reports to Sentry, turning a real signal into noise. Skipping costs nothing —
 * the next online mount re-sends.
 */
export async function registerAndSyncPush(
  endpoint: PushSubscribeEndpoint,
): Promise<{ registration: ServiceWorkerRegistration; shouldPrompt: boolean }> {
  const registration = await navigator.serviceWorker.register('/sw.js')

  const existing = await registration.pushManager.getSubscription()
  if (existing) {
    if (isOnline()) await syncPushSubscription(endpoint, existing)
    return { registration, shouldPrompt: false }
  }

  const permission = Notification.permission
  if (permission === 'default') return { registration, shouldPrompt: true }

  // Previously granted but the subscription was lost — resubscribe silently.
  // 'denied' is respected: no prompt, no subscribe.
  if (permission === 'granted') await subscribeToPush(registration, endpoint)

  return { registration, shouldPrompt: false }
}
