import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// BLOCKER-1 (1c): the generic revocation path's user-id extraction only
// checked payload.user_id / payload.account_id — OwnerRez's shape — which
// meant Hospitable's revocation webhooks (data.user.id, nested) always
// resolved to an empty string and logged "Revocation event missing user_id"
// on every occurrence (confirmed live, 2026-07-27). These tests prove the
// added data.user.id fallback fixes Hospitable while leaving OwnerRez's
// top-level user_id/account_id extraction untouched.
vi.mock('@/lib/integrations/registry', () => ({
  getProvider: vi.fn(),
}))
vi.mock('@/lib/integrations/vault', () => ({
  revokeIntegrationToken: vi.fn(),
  findUserByExternalId:   vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { POST } from '@/app/api/webhooks/[provider]/route'
import { getProvider } from '@/lib/integrations/registry'
import { findUserByExternalId, revokeIntegrationToken } from '@/lib/integrations/vault'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'

function makeSupabase(existingConn: { data?: unknown; error?: unknown }) {
  const from = vi.fn(() => {
    const chain: Record<string, unknown> = {}
    chain.select      = vi.fn(() => chain)
    chain.eq          = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(async () => existingConn)
    // Revocation now runs AFTER the content-hash dedup claim rather than
    // returning ahead of it, so the double has to model the claim insert (and
    // the release on the failure path) or every revocation test throws before
    // it reaches processRevocation.
    chain.insert      = vi.fn(async () => ({ error: null }))
    chain.delete      = vi.fn(() => chain)
    return chain
  })
  return { from }
}

function makeProviderAdapter() {
  return {
    authType:           'apiKey' as const,
    validateWebhook:    vi.fn(() => Promise.resolve({ valid: true })),
    handleWebhookEvent: vi.fn(() => Promise.resolve()),
    getApiHeaders:      vi.fn(() => ({})),
  }
}

function postRequest(providerId: string, body: unknown) {
  return new NextRequest(`http://localhost/api/webhooks/${providerId}`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

function callPost(providerId: string, body: unknown) {
  return POST(postRequest(providerId, body), { params: Promise.resolve({ provider: providerId }) })
}

describe('POST /api/webhooks/[provider] — revocation externalUserId extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getProvider as ReturnType<typeof vi.fn>).mockReturnValue(makeProviderAdapter())
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({ data: { status: 'active', org_id: 'org_1' }, error: null }),
    )
    ;(findUserByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue('user_1')
  })

  it('extracts the user id from Hospitable\'s nested data.user.id and revokes the token', async () => {
    const payload = {
      action: 'application_authorization_revoked',
      data:   { user: { id: 'hosp_user_42', name: 'Costin Soare' } },
    }

    await callPost('hospitable', payload)

    expect(findUserByExternalId).toHaveBeenCalledWith('hospitable', 'hosp_user_42')
    expect(revokeIntegrationToken).toHaveBeenCalledWith('user_1', 'hospitable')
    expect(reportError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ site: 'webhook.provider.revocation_missing_user_id' }),
    )
  })

  it('still extracts OwnerRez\'s top-level numeric user_id unchanged', async () => {
    const payload = { action: 'application_authorization_revoked', user_id: 12345 }

    await callPost('ownerrez', payload)

    expect(findUserByExternalId).toHaveBeenCalledWith('ownerrez', '12345')
    expect(revokeIntegrationToken).toHaveBeenCalledWith('user_1', 'ownerrez')
  })

  it('prefers a top-level user_id over data.user.id when both are somehow present', async () => {
    const payload = {
      action:  'application_authorization_revoked',
      user_id: 999,
      data:    { user: { id: 'hosp_user_should_not_win' } },
    }

    await callPost('hospitable', payload)

    expect(findUserByExternalId).toHaveBeenCalledWith('hospitable', '999')
  })

  it('logs the missing-user-id error when neither shape is present, exactly as before', async () => {
    const payload = { action: 'application_authorization_revoked' }

    await callPost('hospitable', payload)

    expect(findUserByExternalId).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'webhook.provider.revocation_missing_user_id' }),
    )
  })
})
