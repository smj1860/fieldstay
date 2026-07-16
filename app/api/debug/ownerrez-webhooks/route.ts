// TEMPORARY diagnostic route — not part of the product surface.
//
// Purpose: registerWebhookSubscriptions() in ownerrez-api.ts POSTs
// { url, event_type, is_active } to /v2/webhooksubscriptions — an assumed
// shape, never confirmed live. Production has been rejecting every attempt
// with a 400 since at least 2026-06-21: "Property 'url' could not be found
// on 'WebhookSubscriptionModel'... The WebhookUrl field is required." (same
// for event_type/is_active).
//
// Two modes, both GET so hitting the URL in a browser is enough:
//   /api/debug/ownerrez-webhooks              — lists existing subscriptions
//   /api/debug/ownerrez-webhooks?create=X     — tries to CREATE one with
//                                                event type X, using the
//                                                PascalCase field names the
//                                                confirmed error implies
//                                                (WebhookUrl/EventType/
//                                                IsActive), and returns
//                                                whatever OwnerRez says next
//                                                — same live trial-and-error
//                                                loop used earlier this
//                                                session for the
//                                                bookings-fetch endpoint.
// Delete this file once the real shape is confirmed and the production
// code is fixed to match.
//
// Auth: same as the other now-deleted diagnostic routes — requireOrgMember,
// using the current user's own OwnerRez token.
import { NextResponse } from 'next/server'
import { requireOrgMember } from '@/lib/auth'
import { readIntegrationToken } from '@/lib/integrations/vault'

const BASE_URL = 'https://api.ownerrez.com'
const PROVIDER = 'ownerrez'

export async function GET(request: Request) {
  const { user } = await requireOrgMember()

  const token = await readIntegrationToken(user.id, PROVIDER)
  if (!token) {
    return NextResponse.json({ error: 'No OwnerRez token found for this user.' }, { status: 404 })
  }

  const clientId = process.env.OWNERREZ_CLIENT_ID ?? 'unknown'
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent':  `FieldStay/1.0 (${clientId})`,
    Accept:        'application/json',
  }

  const url         = new URL(request.url)
  const createEvent = url.searchParams.get('create')

  if (!createEvent) {
    const res  = await fetch(`${BASE_URL}/v2/webhooksubscriptions`, { headers })
    const body = await res.json().catch(() => null)
    return NextResponse.json({ mode: 'list', status: res.status, body })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  const payload = {
    WebhookUrl: `${appUrl}/api/webhooks/ownerrez`,
    EventType:  createEvent,
    IsActive:   true,
  }

  const res = await fetch(`${BASE_URL}/v2/webhooksubscriptions`, {
    method:  'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  })

  const body = await res.json().catch(() => null)
  return NextResponse.json({ mode: 'create', sentPayload: payload, status: res.status, body })
}
