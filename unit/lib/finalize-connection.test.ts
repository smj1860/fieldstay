// Covers the org-link step of finalizeIntegrationConnection, whose UPDATE
// result was discarded entirely (`await admin.from(...).update(...)`) — a
// failed link left the connection org-less and its initial sync silently never
// ran, and a 0-row match (the row belongs to a DIFFERENT org the user is also
// in) still fired an initial sync attributed to the caller's org.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/integrations/vault', () => ({
  storeIntegrationToken:        vi.fn(),
  storeIntegrationRefreshToken: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { reportError } from '@/lib/observability/report-error'
import { finalizeIntegrationConnection } from '@/lib/integrations/finalize-connection'
import type { TokenResponse } from '@/lib/integrations/types'

type Resp = { data?: unknown; error?: unknown }

/**
 * Two reads happen, in order: the organization_members lookup, then the
 * integration_connections UPDATE read back.
 */
function makeAdmin(membershipResp: Resp, linkResp: Resp) {
  const queue: Record<string, Resp[]> = {
    organization_members:   [membershipResp],
    integration_connections: [linkResp],
  }
  const from = vi.fn((table: string) => {
    const result = queue[table]?.shift() ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'update', 'eq', 'not', 'or', 'order', 'limit']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

const tokenData: TokenResponse = {
  accessToken:    'tok',
  externalUserId: 'ext_1',
} as TokenResponse

describe('finalizeIntegrationConnection — org link', () => {
  beforeEach(() => vi.clearAllMocks())

  it('links the connection and fires the provider initial-sync event', async () => {
    const admin = makeAdmin({ data: { org_id: 'org_1' } }, { data: { id: 'conn_1' }, error: null })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const result = await finalizeIntegrationConnection({
      userId: 'user_1', providerId: 'ownerrez', tokenData,
    })

    expect(result).toEqual({ orgId: 'org_1' })
    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
      name: 'integration/ownerrez.connected',
    }))
  })

  it('throws (rather than silently continuing) when the org link write errors', async () => {
    const admin = makeAdmin(
      { data: { org_id: 'org_1' } },
      { data: null, error: { message: 'deadlock detected' } },
    )
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await expect(finalizeIntegrationConnection({
      userId: 'user_1', providerId: 'ownerrez', tokenData,
    })).rejects.toThrow(/link integration connection/i)

    expect(reportError).toHaveBeenCalled()
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('does not fire an initial sync when the connection belongs to another org (0 rows matched)', async () => {
    const admin = makeAdmin({ data: { org_id: 'org_1' } }, { data: null, error: null })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const result = await finalizeIntegrationConnection({
      userId: 'user_1', providerId: 'ownerrez', tokenData,
    })

    expect(result).toEqual({ orgId: null })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('skips the link entirely for a user with no accepted membership', async () => {
    const admin = makeAdmin({ data: null }, { data: null, error: null })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const result = await finalizeIntegrationConnection({
      userId: 'user_1', providerId: 'ownerrez', tokenData,
    })

    expect(result).toEqual({ orgId: null })
    expect(admin.from).not.toHaveBeenCalledWith('integration_connections')
    expect(inngest.send).not.toHaveBeenCalled()
  })
})
