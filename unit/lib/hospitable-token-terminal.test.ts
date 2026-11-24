import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NonRetriableError } from 'inngest'

// A Hospitable connection whose refresh token is gone (or rejected as
// invalid_grant) can never be fixed by a retry. refreshHospitableToken must
// throw NonRetriableError so integration-token-refresh-handler reads it as
// terminal, marks the connection revoked and emails the PM. A plain Error read
// as transient: the handler retried, exhausted, never emailed, and the same
// failure repeated every hour (Sentry CUSHION-1V, 2026-11-24).
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
  }),
}))
vi.mock('@/lib/integrations/vault', () => ({
  readIntegrationToken:         vi.fn(),
  readIntegrationRefreshToken:  vi.fn(),
  storeIntegrationToken:        vi.fn(),
  storeIntegrationRefreshToken: vi.fn(),
}))

import { refreshHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { readIntegrationRefreshToken } from '@/lib/integrations/vault'

describe('refreshHospitableToken terminal failures', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.HOSPITABLE_CLIENT_ID = 'id'
    process.env.HOSPITABLE_CLIENT_SECRET = 'secret'
  })

  it('throws NonRetriableError when no refresh token is stored', async () => {
    vi.mocked(readIntegrationRefreshToken).mockResolvedValue(null)
    await expect(refreshHospitableToken('user_1', 'ext_1')).rejects.toBeInstanceOf(NonRetriableError)
  })

  it('throws NonRetriableError when Hospitable answers invalid_grant', async () => {
    vi.mocked(readIntegrationRefreshToken).mockResolvedValue('old-token')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ))
    await expect(refreshHospitableToken('user_1', 'ext_1')).rejects.toBeInstanceOf(NonRetriableError)
    vi.unstubAllGlobals()
  })

  it('keeps a 5xx retryable', async () => {
    vi.mocked(readIntegrationRefreshToken).mockResolvedValue('old-token')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })))
    const err = await refreshHospitableToken('user_1', 'ext_1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(NonRetriableError)
    vi.unstubAllGlobals()
  })
})
