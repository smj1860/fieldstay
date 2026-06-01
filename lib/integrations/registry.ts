import * as ownerrez from './providers/ownerrez'

/**
 * Provider action map — keyed by provider slug.
 * Add new providers here as they are implemented.
 */
const providers = {
  ownerrez,
} as const

export type ProviderId = keyof typeof providers

export function getProvider(providerId: string) {
  return providers[providerId as ProviderId] ?? null
}
