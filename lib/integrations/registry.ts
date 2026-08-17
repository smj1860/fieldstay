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
import { hostawayProvider } from './providers/hostaway'
import { hospitableProvider } from './providers/hospitable'
import { hostexProvider } from './providers/hostex'
// Future: import { guestyProvider } from './providers/guesty'

const providers = new Map<string, IntegrationProvider>([
  ['ownerrez',   ownerRezProvider],
  ['kroger',     krogerProvider],
  // Live: sync posts booking revenue and the daily reconcile keeps it current.
  // Its validateWebhook() still rejects every delivery — no webhook endpoint is
  // registered with Hostaway — so inbound webhooks are refused rather than
  // trusted, which is the correct posture until that phase lands.
  ['hostaway',   hostawayProvider],
  ['hospitable', hospitableProvider],
  // Live: integration_providers.hostex.is_active flipped to true by
  // 20260816122829_activate_hostex_provider.sql once sync and webhooks shipped.
  ['hostex',     hostexProvider],
  // ['guesty',   guestyProvider],
])

/**
 * The property-management systems, as opposed to the other things in the map
 * above (Kroger is a grocery retailer, not a PMS).
 *
 * ONE list, because there were three and they had already drifted. Each copy
 * answered "is this org synced from a PMS?" for a different surface and each
 * was updated at a different time: setup/pms had ownerrez + hospitable +
 * hostex, ops/page.tsx's revenue nudge had the same three, and
 * email-trial-lifecycle.tsx checked ONLY ownerrez — so every Hospitable and
 * Hostex org has been receiving a trial email telling them to go connect a
 * PMS they had already connected. That is the drift a per-surface list
 * produces; adding a fourth provider is what surfaced it.
 *
 * Ordered most-established first, which is the order the connect surfaces
 * render them in.
 */
export const PMS_PROVIDER_IDS = ['ownerrez', 'hospitable', 'hostex', 'hostaway'] as const

export type PmsProviderId = typeof PMS_PROVIDER_IDS[number]

/**
 * Human-readable name for a PMS id, for UI and email copy.
 *
 * Accepts null/undefined because every caller passes a value straight off a
 * database row. A required `string` here typechecks and then throws on
 * `.toLowerCase()` the first time a column is null — inside an email step,
 * where the cost is the email not being sent.
 */
export function pmsDisplayName(id: string | null | undefined): string | null {
  if (!id) return null
  const key = id.toLowerCase()
  if (!(PMS_PROVIDER_IDS as readonly string[]).includes(key)) return null
  return providers.get(key)?.displayName ?? null
}

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
