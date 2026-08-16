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
// Hostaway disabled — not ready for launch. Re-enable by uncommenting this
// import and the 'hostaway' map entry below. Do not delete
// lib/integrations/providers/hostaway.ts.
// import { hostawayProvider }   from './providers/hostaway'
import { hospitableProvider } from './providers/hospitable'
import { hostexProvider } from './providers/hostex'
// Future: import { guestyProvider } from './providers/guesty'

const providers = new Map<string, IntegrationProvider>([
  ['ownerrez',   ownerRezProvider],
  ['kroger',     krogerProvider],
  // Hostaway disabled — not ready for launch. Re-enable by uncommenting this
  // line and the import above. Do not delete
  // lib/integrations/providers/hostaway.ts.
  // ['hostaway',   hostawayProvider],
  ['hospitable', hospitableProvider],
  // Live: integration_providers.hostex.is_active flipped to true by
  // 20260816122829_activate_hostex_provider.sql once sync and webhooks shipped.
  ['hostex',     hostexProvider],
  // ['guesty',   guestyProvider],
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
