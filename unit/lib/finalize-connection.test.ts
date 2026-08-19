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
vi.mock('@/lib/integrations/connection-metadata', () => ({
  mergeIntegrationConnectionMetadata: vi.fn(async () => ({})),
}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { reportError } from '@/lib/observability/report-error'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
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

// ============================================================================
// THE RECONNECT LOOP.
//
// store_integration_token sets status='active' but merges metadata with `||`,
// which is SHALLOW — and the token payload carries none of the sync keys. So
// `last_sync_status: 'error'` from the failure that caused the disconnect
// survives a perfectly successful reconnect, and the integrations card reads:
//
//   isError     = status==='error' || status==='revoked' || syncStatus==='error'
//   isConnected = status==='active' && syncStatus==='success'
//
// A freshly reconnected integration therefore renders as Error with a
// Reconnect button. Worse, useSyncProgress treats a stale 'error' as a
// TERMINAL result, so it never starts polling — the card cannot recover when
// the new sync succeeds, and the PM reconnects again, and again, every attempt
// working and every one appearing to fail.
//
// Observed live on 2026-08-19: a reconnected OwnerRez connection sat at
// status='active' still carrying last_reviews_sync_status='error' from before
// the reconnect, because nothing had overwritten that particular key yet.
// ============================================================================
describe('finalizeIntegrationConnection — stale sync state', () => {
  beforeEach(() => vi.clearAllMocks())

  it('clears the previous connection sync result', async () => {
    const admin = makeAdmin({ data: { org_id: 'org_1' } }, { data: { id: 'conn_1' }, error: null })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await finalizeIntegrationConnection({ userId: 'u1', providerId: 'ownerrez', tokenData })

    expect(mergeIntegrationConnectionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        userId:     'u1',
        providerId: 'ownerrez',
        patch: {
          last_sync_status:         null,
          last_sync_error:          null,
          last_sync_detail:         null,
          last_reviews_sync_status: null,
          last_reviews_sync_error:  null,
        },
      }),
    )
  })

  it('clears BEFORE firing the initial sync, so it cannot clobber the new result', async () => {
    // Ordering is the whole correctness argument. Clearing after the sync
    // event could wipe a status the fresh sync had already written, which
    // would reintroduce the same blank-then-wrong state from the other side.
    const order: string[] = []
    vi.mocked(mergeIntegrationConnectionMetadata).mockImplementation(async () => {
      order.push('clear'); return {}
    })
    vi.mocked(inngest.send).mockImplementation(async () => {
      order.push('sync'); return { ids: [] } as never
    })
    const admin = makeAdmin({ data: { org_id: 'org_1' } }, { data: { id: 'conn_1' }, error: null })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await finalizeIntegrationConnection({ userId: 'u1', providerId: 'ownerrez', tokenData })

    expect(order).toEqual(['clear', 'sync'])
  })

  it('clears even when the user has no org yet, so a later sync starts clean', async () => {
    // No org means no initial sync fires — but the connection is still
    // established, and leaving a previous failure attached to it would show
    // the same false Error on the card.
    const admin = makeAdmin({ data: null }, { data: null, error: null })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await finalizeIntegrationConnection({ userId: 'u1', providerId: 'ownerrez', tokenData })

    expect(mergeIntegrationConnectionMetadata).toHaveBeenCalledTimes(1)
    expect(inngest.send).not.toHaveBeenCalled()
  })
})
