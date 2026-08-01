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
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'


// The ONE shared query-builder double, not a local hand-roll. The local
// version modelled only .select/.upsert/.eq/.not/.order, so it broke the
// moment listActiveConnections was paginated onto .range() — exactly the
// divergence unit/stubs/supabase-query-double.ts exists to end. It also
// paginates for real, so a >1000-connection fixture is genuinely walked
// rather than being answered in full on page 0.
const makeSupabase = (tables: Record<string, TableSpec>) => createSupabaseDouble(tables)

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
