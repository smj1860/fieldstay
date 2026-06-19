import 'server-only'
import webpush from 'web-push'
import { createServiceClient } from '@/lib/supabase/server'

export interface SendPushPayload {
  title: string
  body:  string
  url?:  string
}

// Sends a web push notification to every subscription registered for the
// crew member linked to the given auth user. Cleans up subscriptions that
// the push service reports as gone (HTTP 410).
//
// VAPID details are set lazily (not at module scope) so a missing/invalid
// push config can't throw during import and take down every server action
// in this file's module graph (e.g. message sending).
export async function sendPushToUser(userId: string, payload: SendPushPayload): Promise<void> {
  const vapidPublicKey  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY
  if (!vapidPublicKey || !vapidPrivateKey) {
    console.error('[sendPushToUser] VAPID keys not configured — skipping push notification')
    return
  }
  webpush.setVapidDetails(`mailto:${process.env.VAPID_EMAIL}`, vapidPublicKey, vapidPrivateKey)

  const supabase = createServiceClient()

  const { data: crewMember } = await supabase
    .from('crew_members')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle()

  if (!crewMember) return

  const { data: subscriptions } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('crew_member_id', crewMember.id)

  if (!subscriptions || subscriptions.length === 0) return

  const message = JSON.stringify(payload)

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          message
        )
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode
        if (statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id)
        } else {
          console.error('[sendPushToUser] send failed:', statusCode)
        }
      }
    })
  )
}
