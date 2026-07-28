import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable-token', () => ({
  getValidHospitableToken: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable', () => ({
  hospitableFetch: vi.fn(),
}))

import { resolveHospitableOwner } from '@/lib/integrations/providers/hospitable-owner'
import { createServiceClient } from '@/lib/supabase/server'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { hospitableFetch } from '@/lib/integrations/providers/hospitable'
import { RateLimitError } from '@/lib/integrations/types'

interface QueuedByTable { [table: string]: unknown[] }

// Same queue-based Supabase mock pattern used by
// unit/inngest/hospitable-incremental-sync.test.ts: each `.from(table)` call
// consumes the next queued response for that table in call order. Reads that
// end in `.order(...)` (listActiveConnections) or a plain `.eq(...)` chain
// with no terminal method (the local-table lookup) resolve via `.then`;
// reads ending in `.maybeSingle()` resolve via that method instead.
function makeSupabase(queued: QueuedByTable) {
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
    chain.upsert = (...a: unknown[]) => record('upsert', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.not    = (...a: unknown[]) => record('not', a)
    chain.order  = (...a: unknown[]) => record('order', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

const CONN_A = { user_id: 'user_a', org_id: 'org_a', external_user_id: 'hosp_user_a', updated_at: '2026-07-20' }
const CONN_B = { user_id: 'user_b', org_id: 'org_b', external_user_id: 'hosp_user_b', updated_at: '2026-07-19' }

describe('resolveHospitableOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getValidHospitableToken as ReturnType<typeof vi.fn>).mockImplementation(
      async (userId: string) => `token_for_${userId}`,
    )
  })

  it('returns null immediately when there are no active connections at all', async () => {
    const supabase = makeSupabase({ integration_connections: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await resolveHospitableOwner({ entityKind: 'reservation', externalId: 'res_1' })

    expect(result).toBeNull()
  })

  it('resolves directly off the webhook payload\'s external_user_id, skipping cache/local/probe entirely', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_A, CONN_B], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await resolveHospitableOwner({
      entityKind:     'reservation',
      externalId:     'res_1',
      externalUserId: 'hosp_user_b',
    })

    expect(result).toEqual({ orgId: 'org_b', userId: 'user_b', token: 'token_for_user_b' })
    // No cache/local-table/probe queries — only the connections list and the cache write-through
    expect(supabase.calls.some((c) => c.table === 'integration_entity_owners' && c.method === 'upsert')).toBe(true)
    expect(supabase.calls.some((c) => c.table === 'bookings')).toBe(false)
    expect(hospitableFetch).not.toHaveBeenCalled()

    const upsertCall = supabase.calls.find((c) => c.table === 'integration_entity_owners' && c.method === 'upsert')
    expect(upsertCall?.args[0]).toMatchObject({ org_id: 'org_b', resolved_via: 'webhook_user_id' })
  })

  it('falls through to cache/local/probe when external_user_id is present but matches no active connection', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_A], error: null }],
      integration_entity_owners: [{ data: { org_id: 'org_a' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await resolveHospitableOwner({
      entityKind:     'reservation',
      externalId:     'res_1',
      externalUserId: 'hosp_user_disconnected',
    })

    expect(result).toEqual({ orgId: 'org_a', userId: 'user_a', token: 'token_for_user_a' })
  })

  it('resolves from the integration_entity_owners cache when present', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_A, CONN_B], error: null }],
      integration_entity_owners: [{ data: { org_id: 'org_b' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await resolveHospitableOwner({ entityKind: 'property', externalId: 'prop_1' })

    expect(result).toEqual({ orgId: 'org_b', userId: 'user_b', token: 'token_for_user_b' })
    expect(hospitableFetch).not.toHaveBeenCalled()
  })

  it('resolves from a single local-table match and writes through to the cache', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_A, CONN_B], error: null }],
      integration_entity_owners: [{ data: null, error: null }], // cache miss
      properties: [{ data: [{ org_id: 'org_a' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await resolveHospitableOwner({ entityKind: 'property', externalId: 'prop_1' })

    expect(result).toEqual({ orgId: 'org_a', userId: 'user_a', token: 'token_for_user_a' })
    const upsertCall = supabase.calls.find((c) => c.table === 'integration_entity_owners' && c.method === 'upsert')
    expect(upsertCall?.args[0]).toMatchObject({ org_id: 'org_a', resolved_via: 'local' })
  })

  it('probes when the local table has co-hosted matches across two connected orgs, and returns the first 200', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_A, CONN_B], error: null }],
      integration_entity_owners: [{ data: null, error: null }],
      properties: [{ data: [{ org_id: 'org_a' }, { org_id: 'org_b' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(hospitableFetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const result = await resolveHospitableOwner({ entityKind: 'property', externalId: 'prop_shared' })

    expect(result).toEqual({ orgId: 'org_b', userId: 'user_b', token: 'token_for_user_b' })
    expect(hospitableFetch).toHaveBeenCalledTimes(2)
  })

  it('returns null when no connection\'s probe succeeds (entity belongs to a non-customer)', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_A, CONN_B], error: null }],
      integration_entity_owners: [{ data: null, error: null }],
      reviews: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(hospitableFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 404 })

    const result = await resolveHospitableOwner({ entityKind: 'review', externalId: 'rev_x' })

    expect(result).toBeNull()
  })

  it('propagates RateLimitError from the probe so the caller can retry rather than misattributing', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_A], error: null }],
      integration_entity_owners: [{ data: null, error: null }],
      reviews: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(hospitableFetch as ReturnType<typeof vi.fn>).mockRejectedValue(new RateLimitError(30))

    await expect(
      resolveHospitableOwner({ entityKind: 'review', externalId: 'rev_x' }),
    ).rejects.toThrow(RateLimitError)
  })

  it('treats a non-404/403 probe response as inconclusive and tries the next candidate instead of aborting', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_A, CONN_B], error: null }],
      integration_entity_owners: [{ data: null, error: null }],
      reviews: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(hospitableFetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await resolveHospitableOwner({ entityKind: 'review', externalId: 'rev_x' })

    expect(result).toEqual({ orgId: 'org_b', userId: 'user_b', token: 'token_for_user_b' })
    expect(hospitableFetch).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'))
  })

  it('returns null when every candidate is inconclusive (non-404/403 errors), rather than throwing', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_A], error: null }],
      integration_entity_owners: [{ data: null, error: null }],
      reviews: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(hospitableFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500 })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await resolveHospitableOwner({ entityKind: 'review', externalId: 'rev_x' })

    expect(result).toBeNull()
  })

  it('skips a connection whose token is unusable instead of failing the whole resolution', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [CONN_A, CONN_B], error: null }],
      integration_entity_owners: [{ data: null, error: null }],
      reviews: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getValidHospitableToken as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => { throw new Error('Vault miss') })
      .mockImplementationOnce(async (userId: string) => `token_for_${userId}`)
    ;(hospitableFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 })

    const result = await resolveHospitableOwner({ entityKind: 'review', externalId: 'rev_x' })

    expect(result).toEqual({ orgId: 'org_b', userId: 'user_b', token: 'token_for_user_b' })
  })
})
