// lib/integrations/providers/kroger.ts
// ============================================================
// Kroger OAuth 2.0 provider adapter.
//
// Kroger specifics:
//   - Customer OAuth (cart.basic:write profile.compact) is required to add
//     items to a customer's cart. Token exchange uses HTTP Basic Auth.
//   - Access tokens expire (~30 min) and DO have refresh tokens, unlike
//     OwnerRez. refreshAccessToken is implemented.
//   - No webhooks — validateWebhook always rejects, handleWebhookEvent is a no-op.
// ============================================================

import type { IntegrationProvider, TokenResponse } from '../types'
import {
  buildKrogerAuthUrl,
  exchangeCodeForCustomerToken,
  refreshCustomerToken,
  getKrogerProfile,
} from '@/lib/kroger/client'

const FALLBACK_EXTERNAL_USER_ID = 'kroger_customer'

export const krogerProvider: IntegrationProvider = {
  id:          'kroger',
  displayName: 'Kroger',
  authType:    'oauth2',

  // Step 1: Build the URL the user is redirected to on Kroger
  getAuthorizationUrl({ state, redirectUri }) {
    return buildKrogerAuthUrl(state, redirectUri)
  },

  // Step 3: Exchange the temporary code for customer access + refresh tokens
  async exchangeCodeForToken({ code, redirectUri }) {
    const tokens = await exchangeCodeForCustomerToken(code, redirectUri)

    let externalUserId = FALLBACK_EXTERNAL_USER_ID
    try {
      const profile = await getKrogerProfile(tokens.access_token)
      if (profile?.id) externalUserId = profile.id
    } catch (err) {
      console.error('[Kroger] Failed to fetch customer profile', err instanceof Error ? err.message : err)
    }

    return {
      accessToken:    tokens.access_token,
      externalUserId,
      scope:          tokens.scope,
      refreshToken:   tokens.refresh_token,
      expiresAt:      new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    } satisfies TokenResponse
  },

  // Refresh an expired customer access token. Called from build-shopping-cart
  // before each cart build when the stored token is near expiry.
  async refreshAccessToken({ refreshToken }) {
    const tokens = await refreshCustomerToken(refreshToken)

    return {
      accessToken:    tokens.access_token,
      // externalUserId is preserved by the caller — Kroger refresh responses
      // don't repeat the profile id.
      externalUserId: FALLBACK_EXTERNAL_USER_ID,
      scope:          tokens.scope,
      refreshToken:   tokens.refresh_token ?? refreshToken,
      expiresAt:      new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    } satisfies TokenResponse
  },

  // Returns the headers needed for Kroger API calls (cart, products)
  getApiHeaders(token: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json',
      'Content-Type':  'application/json',
    }
  },

  // Kroger does not send webhooks to FieldStay
  async validateWebhook(): Promise<boolean> {
    return false
  },

  async handleWebhookEvent(): Promise<void> {
    // no-op — Kroger has no webhook events
  },
}
