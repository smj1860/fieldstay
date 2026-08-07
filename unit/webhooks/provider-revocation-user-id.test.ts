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
import { revokeIntegrationToken } from '@/lib/integrations/vault'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'

function makeSupabase(existingConn: { data?: unknown; error?: unknown }) {
  // findUserByExternalId() is gone: the handler now reads every connection
  // bound to the external account itself, in one list read. The eq() args are
  // recorded so the extraction assertions below still have something to
  // assert against — that is what these tests are actually about.
  const eqCalls: [string, unknown][] = []
  const from = vi.fn(() => {
    const chain: Record<string, unknown> = {}
    chain.select      = vi.fn(() => chain)
    chain.eq          = vi.fn((col: string, val: unknown) => { eqCalls.push([col, val]); return chain })
    chain.limit       = vi.fn(async () => existingConn)
    chain.maybeSingle = vi.fn(async () => existingConn)
    // Revocation now runs AFTER the content-hash dedup claim rather than
    // returning ahead of it, so the double has to model the claim insert (and
    // the release on the failure path) or every revocation test throws before
    // it reaches processRevocation.
    chain.insert      = vi.fn(async () => ({ error: null }))
    chain.delete      = vi.fn(() => chain)
    return chain
  })
  return { from, eqCalls }
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
  let supabase: ReturnType<typeof makeSupabase>

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getProvider as ReturnType<typeof vi.fn>).mockReturnValue(makeProviderAdapter())
    supabase = makeSupabase({
      data: [{ user_id: 'user_1', status: 'active', org_id: 'org_1' }], error: null,
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
  })

  it('extracts the user id from Hospitable\'s nested data.user.id and revokes the token', async () => {
    const payload = {
      action: 'application_authorization_revoked',
      data:   { user: { id: 'hosp_user_42', name: 'Costin Soare' } },
    }

    await callPost('hospitable', payload)

    expect(supabase.eqCalls).toContainEqual(['external_user_id', 'hosp_user_42'])
    expect(revokeIntegrationToken).toHaveBeenCalledWith('user_1', 'hospitable')
    expect(reportError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ site: 'webhook.provider.revocation_missing_user_id' }),
    )
  })

  it('still extracts OwnerRez\'s top-level numeric user_id unchanged', async () => {
    const payload = { action: 'application_authorization_revoked', user_id: 12345 }

    await callPost('ownerrez', payload)

    expect(supabase.eqCalls).toContainEqual(['external_user_id', '12345'])
    expect(revokeIntegrationToken).toHaveBeenCalledWith('user_1', 'ownerrez')
  })

  it('prefers a top-level user_id over data.user.id when both are somehow present', async () => {
    const payload = {
      action:  'application_authorization_revoked',
      user_id: 999,
      data:    { user: { id: 'hosp_user_should_not_win' } },
    }

    await callPost('hospitable', payload)

    expect(supabase.eqCalls).toContainEqual(['external_user_id', '999'])
  })

  // ── The three defects folding the two reads together fixed ──────────────

  it('does NOT answer 2xx-and-forget when the connection read fails', async () => {
    supabase = makeSupabase({ data: null, error: { message: 'connection reset', code: '08006' } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const payload = {
      action: 'application_authorization_revoked',
      data:   { user: { id: 'hosp_user_42' } },
    }

    // findUserByExternalId() collapsed a failed query and "no such connection"
    // into the same null, and the caller logged "may have already been
    // disconnected" and returned — so the webhook answered 2xx, the provider
    // never redelivered, and a token it had just revoked stayed live in Vault.
    //
    // The read ten lines below it already unwrapped, with a comment saying
    // exactly that. But it ran SECOND, so in the failure it was written for it
    // was never reached: the fix sat behind the bug.
    // The route catches this and answers 500 — which is the point: a 5xx is
    // what makes the provider redeliver. The old path answered 2xx.
    const res = await callPost('hospitable', payload)
    expect(res.status).toBe(500)
    expect(revokeIntegrationToken).not.toHaveBeenCalled()
  })

  it('revokes a connection sitting in error state, not only active ones', async () => {
    supabase = makeSupabase({
      data: [{ user_id: 'user_1', status: 'error', org_id: 'org_1' }], error: null,
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await callPost('hospitable', {
      action: 'application_authorization_revoked',
      data:   { user: { id: 'hosp_user_42' } },
    })

    // The old lookup filtered .eq('status','active') — identity resolution
    // filtered by health. A connection left in 'error' by a failed token
    // refresh resolved to no user, so the provider revoking THAT account never
    // destroyed its Vault secret.
    expect(revokeIntegrationToken).toHaveBeenCalledWith('user_1', 'hospitable')

    // Asserted structurally as well, because the double does not model
    // filters: with only the fixture assertion above, re-adding
    // .eq('status','active') to the query leaves this test passing. Checked by
    // reverting it — which is the only reason this line is here.
    expect(supabase.eqCalls.map(([col]) => col)).not.toContain('status')
  })

  it('revokes every user bound to the external account, not an arbitrary one', async () => {
    supabase = makeSupabase({
      data: [
        { user_id: 'user_1', status: 'active', org_id: 'org_1' },
        { user_id: 'user_2', status: 'active', org_id: 'org_2' },
      ],
      error: null,
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await callPost('hospitable', {
      action: 'application_authorization_revoked',
      data:   { user: { id: 'hosp_user_42' } },
    })

    // integration_connections is UNIQUE (user_id, provider_id) — NOT on
    // external_user_id — so two FieldStay users connecting the same provider
    // account is a legal state. The old .single() errored on it and the
    // swallowed error skipped the revocation entirely. Every connection bound
    // to a revoked external account is invalid.
    expect(revokeIntegrationToken).toHaveBeenCalledWith('user_1', 'hospitable')
    expect(revokeIntegrationToken).toHaveBeenCalledWith('user_2', 'hospitable')
    expect(revokeIntegrationToken).toHaveBeenCalledTimes(2)
  })

  it('still skips when every bound connection is already revoked or disconnected', async () => {
    supabase = makeSupabase({
      data: [
        { user_id: 'user_1', status: 'revoked',      org_id: 'org_1' },
        { user_id: 'user_2', status: 'disconnected', org_id: 'org_2' },
      ],
      error: null,
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await callPost('hospitable', {
      action: 'application_authorization_revoked',
      data:   { user: { id: 'hosp_user_42' } },
    })

    expect(revokeIntegrationToken).not.toHaveBeenCalled()
  })

  it('logs the missing-user-id error when neither shape is present, exactly as before', async () => {
    const payload = { action: 'application_authorization_revoked' }

    await callPost('hospitable', payload)

    expect(supabase.eqCalls).not.toContainEqual(expect.arrayContaining(['external_user_id']))
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'webhook.provider.revocation_missing_user_id' }),
    )
  })
})
