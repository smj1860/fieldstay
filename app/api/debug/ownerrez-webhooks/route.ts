// TEMPORARY diagnostic route — not part of the product surface.
//
// Purpose: registerWebhookSubscriptions() in ownerrez-api.ts POSTs
// { url, event_type, is_active } to /v2/webhooksubscriptions — an assumed
// shape, never confirmed live. Production has been rejecting every attempt
// with a 400 since at least 2026-06-21: "Property 'url' could not be found
// on 'WebhookSubscriptionModel'... The WebhookUrl field is required." (same
// for event_type/is_active). This route does a raw GET on the same
// endpoint (which already succeeds today — only the POST fails) so the
// real field names can be read off the response before fixing the POST
// payload. Delete this file once confirmed.
//
// Auth: same as the other now-deleted diagnostic routes — requireOrgMember,
// using the current user's own OwnerRez token.
import { NextResponse } from 'next/server'
import { requireOrgMember } from '@/lib/auth'
import { readIntegrationToken } from '@/lib/integrations/vault'

const BASE_URL = 'https://api.ownerrez.com'
const PROVIDER = 'ownerrez'

export async function GET() {
  const { user } = await requireOrgMember()

  const token = await readIntegrationToken(user.id, PROVIDER)
  if (!token) {
    return NextResponse.json({ error: 'No OwnerRez token found for this user.' }, { status: 404 })
  }

  const clientId = process.env.OWNERREZ_CLIENT_ID ?? 'unknown'

  const res = await fetch(`${BASE_URL}/v2/webhooksubscriptions`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent':  `FieldStay/1.0 (${clientId})`,
      Accept:        'application/json',
    },
  })

  const body = await res.json().catch(() => null)

  return NextResponse.json({ status: res.status, body })
}
