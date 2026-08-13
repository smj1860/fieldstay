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
// The route consults its inline accountDeleteRatelimit through checkLimit()
// (lib/rate-limit.ts) rather than calling `.limit()` on the limiter directly,
// so that is the seam the tests control. Default: allowed, so every existing
// case exercises the flow past the throttle; the 429 case below overrides it.
const checkLimitMock = vi.fn(async () => ({
  allowed:   true,
  skipped:   false,
  errored:   false,
  limit:     5,
  remaining: 4,
  reset:     Date.now() + 60_000,
}))
vi.mock('@/lib/rate-limit', () => ({
  redis:      {},
  checkLimit: (...args: unknown[]) => checkLimitMock(...(args as [])),
}))
vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class {
    static slidingWindow = () => ({})
    limit = vi.fn(async () => ({ success: true }))
  },
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(async () => undefined),
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
// The destructive half (org purge + auth-user delete) moved to the
// account-deletion Inngest function on 2026-08-09 — the cascade is one
// all-or-nothing statement and this route inherits the platform's default
// maxDuration, so a large tenant could never finish deleting. What the route
// owes now is: refuse for every reason it used to, then hand off exactly once
// with exactly the orgs it validated. That seam is this mock.
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: ['evt_1'] })) },
}))

import { DELETE } from '@/app/api/account/delete/route'
import { createServerClient } from '@supabase/ssr'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { revokeIntegrationToken } from '@/lib/integrations/vault'
import { stripe } from '@/lib/stripe/client'
import { reportError } from '@/lib/observability/report-error'
import { inngest } from '@/lib/inngest/client'

const USER_ID = 'user_1'
const EMAIL   = 'pm@example.com'
const PASSWORD = 'correct-horse'

type Queued = { data?: unknown; error?: unknown; count?: number | null }
type QueuedByTable = Record<string, Queued[]>

/**
 * The route's query sequence per table, in order, is fed from `queued`. Any
 * un-queued call resolves to { data: null, error: null } (a successful no-op),
 * which is what a DELETE against an empty table looks like.
 */
function makeAdmin(queued: QueuedByTable = {}, opts: { deleteUserError?: { message: string }; signOutError?: { message: string } } = {}) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const order: string[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      if (method === 'delete') order.push(`delete:${table}`)
      return chain
    }
    for (const m of ['select', 'eq', 'neq', 'is', 'limit', 'update', 'insert', 'delete'] as const) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  const deleteUser = vi.fn(async (_id: string) => {
    order.push('deleteUser')
    return { error: opts.deleteUserError ?? null }
  })

  // The route no longer deletes the auth user — it revokes the caller's
  // refresh tokens instead, because the user row now disappears at the END of
  // the background job and the session would otherwise outlive the click.
  const signOut = vi.fn(async (_id: string, _scope: string) => {
    order.push('signOut')
    return { error: opts.signOutError ?? null }
  })

  return { from, calls, order, auth: { admin: { deleteUser, signOut } } }
}

/**
 * One mock serves both createServerClient() call sites in the route: the
 * cookie-backed session client (getUser) and the isolated re-auth client
 * (signInWithPassword).
 */
function makeAuthClient(user: { id: string; email?: string } | null, validPassword = PASSWORD) {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user } })),
      signInWithPassword: vi.fn(async ({ password }: { password: string }) =>
        password === validPassword
          ? { error: null }
          : { error: { message: 'Invalid login credentials' } },
      ),
    },
  }
}

function deleteRequest(body: unknown) {
  return new NextRequest('http://localhost/api/account/delete', {
    method:  'DELETE',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

const validBody = { confirm: 'DELETE', password: PASSWORD }

describe('DELETE /api/account/delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an unauthenticated request', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient(null) as never)

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(401)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a request missing the exact confirmation string, before touching the DB', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )

    const res = await DELETE(deleteRequest({ confirm: 'delete', password: PASSWORD }))

    expect(res.status).toBe(400)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  // ── Re-authentication ────────────────────────────────────────────────────
  // A full account + organization wipe must not be reachable from a session
  // cookie alone (borrowed laptop, XSS'd tab).

  it('rejects when no password is supplied — a session cookie alone is not enough', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )

    const res = await DELETE(deleteRequest({ confirm: 'DELETE' }))

    expect(res.status).toBe(400)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  // ── Throttle ─────────────────────────────────────────────────────────────
  // The throttle sits BETWEEN the confirmation check and the password check,
  // so a stolen session cannot be used to brute-force the re-auth password.

  it('returns 429 without ever attempting the password re-auth when throttled', async () => {
    const authClient = makeAuthClient({ id: USER_ID, email: EMAIL })
    vi.mocked(createServerClient).mockReturnValue(authClient as never)
    checkLimitMock.mockResolvedValueOnce({
      allowed:   false,
      skipped:   false,
      errored:   false,
      limit:     5,
      remaining: 0,
      reset:     Date.now() + 60_000,
    })

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(429)
    expect(checkLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      `account-delete:${USER_ID}`,
      // Fails OPEN: a Redis blip must not strand a user exercising a GDPR
      // deletion right — the password re-auth is the real gate.
      { onError: 'allow', site: 'route.account.delete.DELETE' },
    )
    // Only the session client was built — no isolated re-auth client, no admin.
    expect(vi.mocked(createServerClient).mock.calls).toHaveLength(1)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a wrong password without deleting anything', async () => {
    const authClient = makeAuthClient({ id: USER_ID, email: EMAIL })
    vi.mocked(createServerClient).mockReturnValue(authClient as never)
    const admin = makeAdmin()
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest({ confirm: 'DELETE', password: 'wrong' }))

    expect(res.status).toBe(401)
    expect(createServiceClient).not.toHaveBeenCalled()
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
  })

  it('verifies the password against an isolated client that cannot touch the caller\'s session cookies', async () => {
    const authClient = makeAuthClient({ id: USER_ID, email: EMAIL })
    vi.mocked(createServerClient).mockReturnValue(authClient as never)
    vi.mocked(createServiceClient).mockReturnValue(
      makeAdmin({ organization_members: [{ data: [], error: null }] }) as never,
    )

    await DELETE(deleteRequest(validBody))

    // Second createServerClient call is the re-auth client; its cookie adapter
    // must expose no cookies and swallow writes.
    const reauthCall = vi.mocked(createServerClient).mock.calls[1]
    const cookieAdapter = (reauthCall?.[2] as { cookies: { getAll: () => unknown[]; setAll?: unknown } }).cookies
    expect(cookieAdapter.getAll()).toEqual([])
    expect(typeof cookieAdapter.setAll).toBe('function')
  })

  it('deletes only the AUTHENTICATED caller\'s own account — a client-supplied user id in the body is ignored', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members:    [{ data: [{ org_id: 'org_1', role: 'manager' }], error: null }],
      integration_connections: [{ data: [], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(
      deleteRequest({ ...validBody, userId: 'victim_user_id', id: 'victim_user_id' }),
    )

    expect(res.status).toBe(202)
    const membershipEq = admin.calls.filter((c) => c.table === 'organization_members' && c.method === 'eq')
    expect(membershipEq.some((c) => c.args[0] === 'user_id' && c.args[1] === USER_ID)).toBe(true)
    // The id the JOB is told to delete comes from the session, never the body.
    // This is the assertion that matters most now that the deletion happens
    // out of band: the event payload is the only thing the job trusts.
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'account/deletion.requested',
      data: { user_id: USER_ID, owned_org_ids: [] },
    })
    expect(admin.auth.admin.signOut).toHaveBeenCalledWith(USER_ID, 'global')
    expect(admin.auth.admin.signOut).not.toHaveBeenCalledWith('victim_user_id', expect.anything())
  })

  it('blocks deleting an owner account while other org members still exist', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members: [
        { data: [{ org_id: 'org_1', role: 'owner' }], error: null },
        { data: null, error: null, count: 2 },
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(409)
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled()
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
  })

  // ── Fail-closed error handling (H4) ───────────────────────────────────────

  it('FAILS CLOSED when the other-members count query errors — a failed count must never read as zero', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members: [
        { data: [{ org_id: 'org_1', role: 'owner' }], error: null },
        { data: null, error: { message: 'db down' }, count: null },
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(503)
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
    expect(admin.calls.some((c) => c.table === 'organizations' && c.method === 'delete')).toBe(false)
  })

  it('ABORTS when the organizations lookup errors — otherwise both Stripe cancel blocks silently skip and the user is deleted with a live subscription', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members: [
        { data: [{ org_id: 'org_1', role: 'owner' }], error: null },
        { data: null, error: null, count: 0 },
      ],
      organizations: [{ data: null, error: { message: 'db down' } }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(503)
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ site: 'route.account.delete.org_lookup' }),
    )
  })

  it('ABORTS when the integration_connections lookup errors — revoking nothing would strand live third-party tokens in Vault', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members:    [{ data: [{ org_id: 'org_1', role: 'manager' }], error: null }],
      integration_connections: [{ data: null, error: { message: 'db down' } }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(503)
    expect(revokeIntegrationToken).not.toHaveBeenCalled()
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
  })

  it('aborts (without deleting the account) when cancelling the owner\'s Stripe subscription fails — avoids an orphaned billing subscription', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members: [
        { data: [{ org_id: 'org_1', role: 'owner' }], error: null },
        { data: null, error: null, count: 0 },
      ],
      organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(stripe.subscriptions.cancel).mockRejectedValueOnce(new Error('stripe down'))

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(503)
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
    expect(logAuditEvents).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'route.account.delete.stripe_cancel' }),
    )
  })

  it('treats an already-cancelled Stripe subscription as success, so a retry after a partial failure is not permanently blocked', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members: [
        { data: [{ org_id: 'org_1', role: 'owner' }], error: null },
        { data: null, error: null, count: 0 },
      ],
      organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
      integration_connections: [{ data: [], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(stripe.subscriptions.cancel).mockRejectedValueOnce(
      Object.assign(new Error('No such subscription: sub_1'), { code: 'resource_missing' }),
    )

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(202)
    expect(inngest.send).toHaveBeenCalledTimes(1)
  })

  // ── B3: the organization must still be destroyed — now by the handoff ────

  it('HANDS THE ORGANIZATION OFF for purging when the user solely owns it — the org must not survive the auth user', async () => {
    // B-3, restated for the async shape. Deleting only the auth user orphans
    // every org-scoped table (properties, bookings with guest PII,
    // owner_transactions) behind zero members, unreachable by RLS and never
    // purged — it happened in production on 2026-07-30. The route no longer
    // performs that purge, so what it owes is that the org reaches the job
    // that does.
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members: [
        { data: [{ org_id: 'org_1', role: 'owner' }], error: null },
        { data: null, error: null, count: 0 },
      ],
      organizations: [{ data: { stripe_subscription_id: null }, error: null }],
      integration_connections: [{ data: [], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(202)
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'account/deletion.requested',
      data: { user_id: USER_ID, owned_org_ids: ['org_1'] },
    })
    // And the route itself destroys nothing any more — the ordering guarantees
    // that used to live here are asserted against the job, in
    // unit/inngest/account-deletion.test.ts.
    expect(admin.order).not.toContain('delete:organizations')
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
  })

  it('revokes the caller\'s sessions on handoff — the auth user now outlives the response', async () => {
    // The user row is deleted at the END of the background job, deliberately:
    // while it exists the tenant is reachable and the purge is re-drivable,
    // whereas deleting it first turns a failed purge into an orphan nobody can
    // find. That leaves a window where the session outlives the click, so the
    // refresh tokens are revoked here.
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members:    [{ data: [{ org_id: 'org_1', role: 'manager' }], error: null }],
      integration_connections: [{ data: [], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await DELETE(deleteRequest(validBody))

    expect(admin.auth.admin.signOut).toHaveBeenCalledWith(USER_ID, 'global')
  })

  it('still succeeds when the sign-out fails — the job removes the user regardless', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin(
      {
        organization_members:    [{ data: [{ org_id: 'org_1', role: 'manager' }], error: null }],
        integration_connections: [{ data: [], error: null }],
      },
      { signOutError: { message: 'gotrue down' } },
    )
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest(validBody))

    // The only person holding that session is the one who just asked for all
    // of this to be destroyed. Failing the request here would strand a GDPR
    // deletion on a cosmetic step.
    expect(res.status).toBe(202)
    expect(inngest.send).toHaveBeenCalledTimes(1)
  })

  it('returns 503 and destroys NOTHING when the handoff itself fails', async () => {
    // The send is the last thing that can fail cheaply, which is exactly why
    // it sits before the response and before the sign-out. If it throws, the
    // account is fully intact and fully retryable; if it were fired after
    // anything irreversible, a queue outage would leave a half-deleted account
    // with no job coming for it.
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members: [
        { data: [{ org_id: 'org_1', role: 'owner' }], error: null },
        { data: null, error: null, count: 0 },
      ],
      organizations: [{ data: { stripe_subscription_id: null }, error: null }],
      integration_connections: [{ data: [], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(inngest.send).mockRejectedValueOnce(new Error('inngest unreachable'))

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(503)
    expect(admin.order).not.toContain('delete:organizations')
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
    expect(admin.auth.admin.signOut).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'route.account.delete.enqueue' }),
    )
  })

  it('does NOT delete an organization the user merely belongs to but does not own', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members:    [{ data: [{ org_id: 'org_1', role: 'manager' }], error: null }],
      integration_connections: [{ data: [], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(202)
    // The handoff carries an EMPTY owned list — a membership the user does not
    // own must never reach the purge, which deletes the organizations row
    // outright. The auth-user cascade is what cleans up their membership row.
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'account/deletion.requested',
      data: { user_id: USER_ID, owned_org_ids: [] },
    })
  })

  // ── Happy path & remaining behaviours ─────────────────────────────────────

  it('cancels an owner\'s Stripe subscriptions, revokes integration tokens, audits, and deletes the auth user on the happy path', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members: [
        { data: [{ org_id: 'org_1', role: 'owner' }], error: null },
        { data: null, error: null, count: 0 },
      ],
      organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
      integration_connections: [{ data: [{ provider_id: 'ownerrez' }, { provider_id: 'kroger' }], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(202)
    // `ok: true` is preserved so the client contract is unchanged (it redirects
    // to /login?deleted=1); `queued` is what says the work is not finished yet.
    await expect(res.json()).resolves.toEqual({ ok: true, queued: true })

    // Only the core subscription now. organizations.repuguard_stripe_subscription_id
    // was dropped with the standalone RepuGuard product — nothing had created
    // such a subscription for a long time and 0 of 8 production orgs held a
    // value, so that cancel branch was unreachable rather than merely idle.
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_1')
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1)
    // org_id survives in metadata because audit_events.org_id is
    // ON DELETE SET NULL and the organizations row is about to disappear.
    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        orgId:    'org_1',
        actorId:  USER_ID,
        action:   'account.deleted',
        metadata: { org_id: 'org_1' },
      }),
    ])
    expect(revokeIntegrationToken).toHaveBeenCalledWith(USER_ID, 'ownerrez')
    expect(revokeIntegrationToken).toHaveBeenCalledWith(USER_ID, 'kroger')
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'account/deletion.requested',
      data: { user_id: USER_ID, owned_org_ids: ['org_1'] },
    })
  })

  it('continues the delete flow even when revoking one integration token fails, reporting the error', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members:    [{ data: [{ org_id: 'org_1', role: 'manager' }], error: null }],
      integration_connections: [{ data: [{ provider_id: 'ownerrez' }, { provider_id: 'kroger' }], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(revokeIntegrationToken)
      .mockRejectedValueOnce(new Error('vault unreachable'))
      .mockResolvedValueOnce(undefined)

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(202)
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'route.account.delete.vault_revoke' }),
    )
    expect(inngest.send).toHaveBeenCalledTimes(1)
  })

  it('returns 500 when the initial membership lookup errors', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      makeAuthClient({ id: USER_ID, email: EMAIL }) as never,
    )
    const admin = makeAdmin({
      organization_members: [{ data: null, error: { message: 'db down' } }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await DELETE(deleteRequest(validBody))

    expect(res.status).toBe(500)
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
  })
})
