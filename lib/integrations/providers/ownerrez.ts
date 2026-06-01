/**
 * OwnerRez-specific OAuth logic.
 *
 * Auth for OAuth token exchange: HTTP Basic (Client ID : Client Secret)
 * Auth for API calls:            Bearer token
 * Auth for webhook verification: HTTP Basic (OWNERREZ_WEBHOOK_USER : OWNERREZ_WEBHOOK_PASSWORD)
 */

import type { OAuthTokenResponse, WebhookEvent } from '../types'

const AUTH_URL    = 'https://app.ownerrez.com/oauth/authorize'
const TOKEN_URL   = 'https://api.ownerrez.com/oauth/access_token'
const REVOKE_BASE = 'https://api.ownerrez.com/oauth/access_token'

export function getAuthorizationUrl(state: string, redirectUri: string): string {
  const clientId = process.env.OWNERREZ_CLIENT_ID
  if (!clientId) throw new Error('OWNERREZ_CLIENT_ID is not set')

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    state,
  })
  return `${AUTH_URL}?${params.toString()}`
}

export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<OAuthTokenResponse> {
  const clientId     = process.env.OWNERREZ_CLIENT_ID
  const clientSecret = process.env.OWNERREZ_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('OWNERREZ_CLIENT_ID or OWNERREZ_CLIENT_SECRET is not set')
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
      'User-Agent':    `FieldStay/1.0 (${clientId})`,
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`[OwnerRez] Token exchange failed (${res.status}): ${body}`)
  }

  return res.json() as Promise<OAuthTokenResponse>
}

export async function revokeToken(accessToken: string): Promise<void> {
  const clientId     = process.env.OWNERREZ_CLIENT_ID
  const clientSecret = process.env.OWNERREZ_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('OWNERREZ_CLIENT_ID or OWNERREZ_CLIENT_SECRET is not set')
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  await fetch(`${REVOKE_BASE}/${accessToken}`, {
    method:  'DELETE',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'User-Agent':    `FieldStay/1.0 (${clientId})`,
    },
  })
  // Best-effort — OwnerRez may already have revoked the token
}

export function verifyWebhookAuth(authHeader: string | null): boolean {
  const user     = process.env.OWNERREZ_WEBHOOK_USER
  const password = process.env.OWNERREZ_WEBHOOK_PASSWORD
  if (!user || !password) return false
  if (!authHeader?.startsWith('Basic ')) return false

  const expected = Buffer.from(`${user}:${password}`).toString('base64')
  const provided = authHeader.slice('Basic '.length)
  return provided === expected
}

export function parseWebhookEvent(body: unknown): WebhookEvent {
  if (typeof body !== 'object' || body === null) throw new Error('Invalid webhook body')
  return body as WebhookEvent
}
