import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { reportTurnoverIssue, submitAssetDiscovery } from '@/app/crew/turnovers/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>, user: { id: string } | null = { id: 'user_1' }) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'not', 'limit']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  const auth = { getUser: vi.fn(async () => ({ data: { user } })) }
  return { from, auth }
}

const CREW = { id: 'crew_1', org_id: 'org_1' }

function mockCrewAuthed(supabase: ReturnType<typeof makeSupabase>) {
  vi.mocked(createClient).mockResolvedValue(supabase as never)
}

describe('crew/turnovers/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('reportTurnoverIssue', () => {
    it('files a work order for a turnover verified to belong to the crew member org', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: CREW }],
        turnovers:    [{ data: { id: 't_1', property_id: 'prop_1', org_id: 'org_1' } }],
        work_orders:  [{ error: null }],
      })
      mockCrewAuthed(supabase)

      const result = await reportTurnoverIssue('t_1', 'Broken AC', 'not cooling', 'high')

      expect(result).toEqual({ success: true })
      expect(supabase.from).toHaveBeenCalledWith('work_orders')
    })

    it('rejects a blank title before touching the DB', async () => {
      const supabase = makeSupabase({})
      mockCrewAuthed(supabase)

      const result = await reportTurnoverIssue('t_1', '   ', null, 'medium')

      expect(result).toEqual({ error: 'Please describe the issue.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects when the caller is not authenticated', async () => {
      const supabase = makeSupabase({}, null)
      mockCrewAuthed(supabase)

      const result = await reportTurnoverIssue('t_1', 'Broken AC', null, 'medium')

      expect(result).toEqual({ error: 'Failed to report issue' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects when the authenticated user has no active crew_members record', async () => {
      const supabase = makeSupabase({ crew_members: [{ data: null }] })
      mockCrewAuthed(supabase)

      const result = await reportTurnoverIssue('t_1', 'Broken AC', null, 'medium')

      expect(result).toEqual({ error: 'Failed to report issue' })
      expect(supabase.from).not.toHaveBeenCalledWith('turnovers')
      expect(supabase.from).not.toHaveBeenCalledWith('work_orders')
    })

    it('rejects a turnover id that does not belong to the crew member org (IDOR check)', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: CREW }],
        turnovers:    [{ data: null }],
      })
      mockCrewAuthed(supabase)

      const result = await reportTurnoverIssue('other-orgs-turnover', 'Broken AC', null, 'medium')

      expect(result).toEqual({ error: 'Turnover not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('work_orders')
    })

    it('treats a duplicate flag on the same turnover as a no-op success', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: CREW }],
        turnovers:    [{ data: { id: 't_1', property_id: 'prop_1', org_id: 'org_1' } }],
        work_orders:  [{ error: { code: '23505' } }],
      })
      mockCrewAuthed(supabase)

      const result = await reportTurnoverIssue('t_1', 'Broken AC', null, 'medium')

      expect(result).toEqual({ success: true })
    })
  })

  describe('submitAssetDiscovery', () => {
    const payload = { make: 'Trane', model: 'XR16', photo_url: null, is_na: false }

    it('creates a new asset when the crew is assigned to an active turnover at the property', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: CREW }],
        turnovers:    [{ data: { id: 't_1' } }], // assignedTurnover lookup
      })
      mockCrewAuthed(supabase)
      const admin = makeSupabase({
        property_assets: [
          { data: null },                       // existing lookup
          { data: { id: 'asset_1' }, error: null }, // insert
        ],
      })
      vi.mocked(createServiceClient).mockReturnValue(admin as never)

      const result = await submitAssetDiscovery('prop_1', 'hvac', payload)

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        orgId: 'org_1', action: 'asset.created', targetId: 'asset_1',
      }))
    })

    it('updates an existing asset record when one already exists for the property/asset type', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: CREW }],
        turnovers:    [{ data: { id: 't_1' } }],
      })
      mockCrewAuthed(supabase)
      const admin = makeSupabase({
        property_assets: [
          { data: { id: 'asset_existing' } }, // existing lookup
          { error: null },                    // update
        ],
      })
      vi.mocked(createServiceClient).mockReturnValue(admin as never)

      const result = await submitAssetDiscovery('prop_1', 'hvac', payload)

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'asset.updated', targetId: 'asset_existing',
      }))
    })

    it('rejects an unknown asset type before touching the DB', async () => {
      const supabase = makeSupabase({})
      mockCrewAuthed(supabase)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await submitAssetDiscovery('prop_1', 'not_a_real_type' as any, payload)

      expect(result).toEqual({ error: 'Unknown asset type' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects an empty submission with no details and not marked N/A', async () => {
      const supabase = makeSupabase({})
      mockCrewAuthed(supabase)

      const result = await submitAssetDiscovery('prop_1', 'hvac', { make: null, model: null, photo_url: null, is_na: false })

      expect(result).toEqual({ error: 'Provide asset details or mark as not applicable' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects when the caller is not authenticated', async () => {
      const supabase = makeSupabase({}, null)
      mockCrewAuthed(supabase)

      const result = await submitAssetDiscovery('prop_1', 'hvac', payload)

      expect(result).toEqual({ error: 'Failed to submit asset discovery' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects when the authenticated user has no active crew_members record', async () => {
      const supabase = makeSupabase({ crew_members: [{ data: null }] })
      mockCrewAuthed(supabase)

      const result = await submitAssetDiscovery('prop_1', 'hvac', payload)

      expect(result).toEqual({ error: 'Failed to submit asset discovery' })
    })

    it('rejects a property the crew member is not assigned to at their own org (IDOR/cross-org check)', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: CREW }],
        turnovers:    [{ data: null }], // no active assignment at this property for this org
      })
      mockCrewAuthed(supabase)

      const result = await submitAssetDiscovery('other-orgs-property', 'hvac', payload)

      expect(result).toEqual({ error: 'Property not found' })
      expect(createServiceClient).not.toHaveBeenCalled()
    })
  })
})
