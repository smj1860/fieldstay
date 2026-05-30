import webpush from 'web-push'

// Required env vars (server-only):
//   VAPID_CONTACT_EMAIL   — e.g. "admin@fieldstay.app"
//   NEXT_PUBLIC_VAPID_PUBLIC_KEY  — VAPID public key (also used client-side)
//   VAPID_PRIVATE_KEY     — VAPID private key (never expose to client)

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_CONTACT_EMAIL}`,
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
)

export interface PushPayload {
  title: string
  body:  string
  url:   string
}

export async function sendPushToCrewMember(
  subscriptions: { endpoint: string; p256dh: string; auth: string }[],
  payload: PushPayload
): Promise<void> {
  const message = JSON.stringify(payload)

  await Promise.allSettled(
    subscriptions.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        message
      ).catch((err: { statusCode?: number }) => {
        if (err.statusCode === 410) {
          console.error('[push] expired subscription:', sub.endpoint.slice(-20))
        } else {
          console.error('[push] send failed:', err.statusCode)
        }
      })
    )
  )
}
