// src/lib/integrations/registry.ts
// ============================================================
// Central registry of all integration provider adapters.
//
// To add a new integration:
//   1. Create src/lib/integrations/providers/your-provider.ts
//   2. Add one line to the providers map below
//   3. Add one row to the integration_providers DB table
//
// That's it. No other files change.
// ============================================================

import type { IntegrationProvider } from './types'
import { ownerRezProvider } from './providers/ownerrez'
import { krogerProvider } from './providers/kroger'
// Future: import { guestyProvider } from './providers/guesty'
// Future: import { hostawayProvider } from './providers/hostaway'

const providers = new Map<string, IntegrationProvider>([
  ['ownerrez', ownerRezProvider],
  ['kroger',   krogerProvider],
  // ['guesty',   guestyProvider],
  // ['hostaway', hostawayProvider],
])

/**
 * Look up a provider by its ID string.
 * Throws if the provider is not registered — callers should catch this
 * and return a 404 to the client.
 */
export function getProvider(id: string): IntegrationProvider {
  const provider = providers.get(id.toLowerCase())
  if (!provider) {
    throw new Error(`Integration provider not found: "${id}"`)
  }
  return provider
}

/**
 * Returns all registered providers.
 * Useful for rendering a "Connect an integration" UI.
 */
export function listProviders(): IntegrationProvider[] {
  return Array.from(providers.values())
}

/**
 * Returns all active OAuth2 providers.
 */
export function listOAuthProviders(): IntegrationProvider[] {
  return listProviders().filter((p) => p.authType === 'oauth2')
}
