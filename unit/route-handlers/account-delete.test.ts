import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ getAll: () => [] })),
}))
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(async () => undefined),
}))
vi.mock('@/lib/integrations/vault', () => ({
  revokeIntegrationToken: vi.fn(async () => undefined),
}))
vi.mock('@/lib/stripe/client', () => ({
  stripe: { subscriptions: { cancel: vi.fn(async () => undefined) } },
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { DELETE } from '@/app/api/account/delete/route'
import { createServerClient } from '@supabase/ssr'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { revokeIntegrationToken } from '@/lib/integrations/vault'
import { stripe } from '@/lib/stripe/client'
import { reportError } from '@/lib/observability/report-error'

const USER_ID = 'user_1'

type QueuedByTable = Record<string, Array<{ data?: unknown; error?: unknown; count?: number | null }>>

function makeAdmin(queued: QueuedByTable = {}, opts: { deleteUserError?: { message: string } } = {}) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.neq    = (...a: unknown[]) => record('neq', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.single = () => resolveNext()
    chain.then   = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  const deleteUser = vi.fn(async (_id: string) => ({ error: opts.deleteUserError ?? null }))

  return { from, calls, auth: { admin: { deleteUser } } }
}

function makeAuthClient(user: { id: string } | null) {
  return { auth: { getUser: vi.fn(async () => ({ data: { user } })) } }
}

function deleteRequest(body: unknown) {
  return new NextRequest('http://localhost/api/account/delete', {
    method:  'DELETE',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

describe('DELETE /api/account/delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an unauthenticated request', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient(null) as never)

    const res = await DELETE(deleteRequest({ confirm: 'DELETE' }))

    expect(res.status).toBe(401)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a request missing the exact confirmation string, before touching the DB', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)

    const res = await DELETE(deleteRequest({ confirm: 'delete' }))

    expect(res.status).toBe(400)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('deletes only the AUTHENTICATED caller\'s own account — a client-supplied user id in the body is ignored', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members:  [{ data: [{ org_id: 'org_1', role: 'manager' }], error: null }],
      integration_connections: [{ data: [], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest({ confirm: 'DELETE', userId: 'victim_user_id', id: 'victim_user_id' }))

    expect(res.status).toBe(200)
    // The membership lookup and the final auth deletion both key off the
    // authenticated session's user id, never anything from the request body.
    const membershipEq = admin.calls.filter((c) => c.table === 'organization_members' && c.method === 'eq')
    expect(membershipEq.some((c) => c.args[0] === 'user_id' && c.args[1] === USER_ID)).toBe(true)
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith(USER_ID)
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalledWith('victim_user_id')
  })

  it('blocks deleting an owner account while other org members still exist', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [
        { data: [{ org_id: 'org_1', role: 'owner' }], error: null },
        { data: null, error: null, count: 2 },
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest({ confirm: 'DELETE' }))

    expect(res.status).toBe(409)
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled()
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
  })

  it('aborts (without deleting the account) when cancelling the owner\'s Stripe subscription fails — avoids an orphaned billing subscription', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [
        { data: [{ org_id: 'org_1', role: 'owner' }], error: null },
        { data: null, error: null, count: 0 },
      ],
      organizations: [{ data: { stripe_subscription_id: 'sub_1', repuguard_stripe_subscription_id: null }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(stripe.subscriptions.cancel).mockRejectedValueOnce(new Error('stripe down'))

    const res = await DELETE(deleteRequest({ confirm: 'DELETE' }))

    expect(res.status).toBe(503)
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'route.account.delete.stripe_cancel' }),
    )
  })

  it('cancels an owner\'s Stripe subscriptions, revokes integration tokens, audits, and deletes the auth user on the happy path', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [
        { data: [{ org_id: 'org_1', role: 'owner' }], error: null },
        { data: null, error: null, count: 0 },
      ],
      organizations: [{ data: { stripe_subscription_id: 'sub_1', repuguard_stripe_subscription_id: 'sub_rg_1' }, error: null }],
      integration_connections: [{ data: [{ provider_id: 'ownerrez' }, { provider_id: 'kroger' }], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest({ confirm: 'DELETE' }))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })

    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_1')
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_rg_1')
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org_1', actorId: USER_ID, action: 'account.deleted' }),
    )
    expect(revokeIntegrationToken).toHaveBeenCalledWith(USER_ID, 'ownerrez')
    expect(revokeIntegrationToken).toHaveBeenCalledWith(USER_ID, 'kroger')
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith(USER_ID)
  })

  it('continues the delete flow even when revoking one integration token fails, reporting the error', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members:    [{ data: [{ org_id: 'org_1', role: 'manager' }], error: null }],
      integration_connections: [{ data: [{ provider_id: 'ownerrez' }, { provider_id: 'kroger' }], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(revokeIntegrationToken)
      .mockRejectedValueOnce(new Error('vault unreachable'))
      .mockResolvedValueOnce(undefined)

    const res = await DELETE(deleteRequest({ confirm: 'DELETE' }))

    expect(res.status).toBe(200)
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'route.account.delete.vault_revoke' }),
    )
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith(USER_ID)
  })

  it('returns 500 when the final auth user deletion itself fails', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin(
      {
        organization_members:    [{ data: [{ org_id: 'org_1', role: 'manager' }], error: null }],
        integration_connections: [{ data: [], error: null }],
      },
      { deleteUserError: { message: 'auth service down' } },
    )
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest({ confirm: 'DELETE' }))

    expect(res.status).toBe(500)
  })

  it('returns 500 when the initial membership lookup errors', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: null, error: { message: 'db down' } }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest({ confirm: 'DELETE' }))

    expect(res.status).toBe(500)
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
  })
})
