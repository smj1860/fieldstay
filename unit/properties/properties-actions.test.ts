import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
  // Mirrors Next's real behavior: rethrow control-flow errors (redirect/notFound)
  // so they escape a surrounding try/catch instead of being swallowed into a
  // generic error response.
  unstable_rethrow: (err: unknown) => {
    if (err instanceof Error && err.message.startsWith('REDIRECT:')) throw err
  },
}))
vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/geocoding', () => ({ geocodeZip: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/checklists/apply-master-template', () => ({
  applyMasterChecklistToProperty: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { requireOrgMember } from '@/lib/auth'
import { geocodeZip } from '@/lib/geocoding'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { applyMasterChecklistToProperty } from '@/lib/checklists/apply-master-template'
import { inngest } from '@/lib/inngest/client'
import {
  createProperty,
  updateProperty,
  revealPropertyDoorCode,
  markStepComplete,
  createAsset,
  updateAsset,
  deactivateAsset,
  bulkImportAssets,
  archiveProperty,
  type CsvAssetRow,
} from '@/app/(dashboard)/properties/actions'

type Resp = { data?: unknown; error?: unknown; count?: number }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'in', 'not', 'is', 'limit']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  const rpc = vi.fn((): Promise<{ data: unknown; error: unknown }> => Promise.resolve({ data: null, error: null }))
  return { from, rpc, calls }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

function fd(fields: Record<string, string> = {}) {
  const f = new FormData()
  f.append('name', 'Lakeview Cottage')
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  return f
}

describe('properties/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createProperty', () => {
    it('creates a property, geocodes on save, applies the master checklist, and redirects to setup/details', async () => {
      const supabase = makeSupabase({
        properties: [
          { data: null, count: 0, error: null },
          { data: { id: 'prop_1' } },
          { error: null }, // lat/lng geocode update
        ],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)
      vi.mocked(geocodeZip).mockResolvedValue({ lat: 32.6, lng: -85.9 })

      await expect(createProperty(null, fd({ zip: '36853', door_code: '1234' })))
        .rejects.toThrow('REDIRECT:/properties/prop_1/setup/details')

      expect(geocodeZip).toHaveBeenCalledWith('36853')
      expect(supabase.rpc).toHaveBeenCalledWith('store_property_door_code', {
        p_property_id: 'prop_1', p_org_id: 'org_1', p_door_code: '1234',
      })
      expect(applyMasterChecklistToProperty).toHaveBeenCalledWith(
        'prop_1', 'org_1', supabase, { force: false, actorId: 'user_1' }
      )
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'property.created' }))
    })

    it('rejects when the property name is missing', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership, user: { id: 'user_1' } } as never)

      const emptyForm = new FormData()
      const result = await createProperty(null, emptyForm)

      expect(result).toEqual({ error: 'Property name is required' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects once the org has reached its plan property limit', async () => {
      const supabase = makeSupabase({
        properties: [{ data: null, count: 25, error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership, user: { id: 'user_1' } } as never)

      const result = await createProperty(null, fd())

      expect(result).toEqual({
        error: 'Your plan allows up to 25 properties. Upgrade to add more.',
      })
      expect(supabase.from).toHaveBeenCalledTimes(1)
    })

    it('rejects and never touches the DB when the caller is unauthenticated', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(createProperty(null, fd())).rejects.toThrow('REDIRECT:/login')
    })
  })

  describe('updateProperty', () => {
    it('updates a property scoped to the caller org', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { zip: '36853' } }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateProperty('prop_1', null, fd({ zip: '36853' }))

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'property.updated' }))
    })

    it('geocodes and patches lat/lng only when the ZIP actually changes', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { zip: '36853' } }, { error: null }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)
      vi.mocked(geocodeZip).mockResolvedValue({ lat: 32.6, lng: -85.9 })

      await updateProperty('prop_1', null, fd({ zip: '36854' }))

      expect(geocodeZip).toHaveBeenCalledWith('36854')
    })

    it('scopes the update to the caller org, not just the property id (IDOR check)', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { zip: null } }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await updateProperty('other-orgs-property', null, fd())

      const eqCalls = supabase.calls.filter((c) => c.table === 'properties' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
    })

    it('rejects when the property name is missing', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership, user: { id: 'user_1' } } as never)

      const emptyForm = new FormData()
      const result = await updateProperty('prop_1', null, emptyForm)

      expect(result).toEqual({ error: 'Property name is required' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await updateProperty('prop_1', null, fd())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('revealPropertyDoorCode', () => {
    it('decrypts and returns the door code, auditing the reveal', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { id: 'prop_1', door_code_secret_id: 'secret_1' } }],
      })
      vi.mocked(supabase.rpc).mockResolvedValue({ data: '4821', error: null })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await revealPropertyDoorCode('prop_1')

      expect(result).toEqual({ doorCode: '4821' })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'property.door_code.viewed' }))
    })

    it('returns null without calling the decrypt RPC when no door code is set', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { id: 'prop_1', door_code_secret_id: null } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await revealPropertyDoorCode('prop_1')

      expect(result).toEqual({ doorCode: null })
      expect(supabase.rpc).not.toHaveBeenCalled()
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await revealPropertyDoorCode('other-orgs-property')

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.rpc).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await revealPropertyDoorCode('prop_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('markStepComplete', () => {
    it('marks a setup step complete, scoped to the caller org', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { setup_steps_completed: { details: true } } }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership, user: { id: 'user_1' } } as never)

      await expect(markStepComplete('prop_1', 'ical')).resolves.toBeUndefined()

      const eqCalls = supabase.calls.filter((c) => c.table === 'properties' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
    })

    it('propagates the failure when the caller is unauthenticated', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('boom'))

      await expect(markStepComplete('prop_1', 'ical')).rejects.toThrow('boom')
    })
  })

  describe('createAsset', () => {
    function buildAssetForm(fields: Record<string, string> = {}) {
      const f = new FormData()
      f.append('name', 'Water heater')
      f.append('asset_type', 'water_heater')
      for (const [k, v] of Object.entries(fields)) f.append(k, v)
      return f
    }

    it('creates an asset when the property belongs to the caller org', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: 'prop_1' } }],
        asset_type_standards:  [{ data: null }],
        property_assets:       [{ data: { id: 'asset_1' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createAsset('prop_1', null, buildAssetForm({ make: 'Rheem', model: 'XE50' }))

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'asset.created' }))
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'asset/manual_lookup.requested',
        data: { org_id: 'org_1', asset_type: 'water_heater', make: 'Rheem', model: 'XE50' },
      })
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createAsset('other-orgs-property', null, buildAssetForm())

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('property_assets')
    })

    it('rejects when required fields are missing', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const emptyForm = new FormData()
      const result = await createAsset('prop_1', null, emptyForm)

      expect(result).toEqual({ error: 'Asset name is required' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('updateAsset', () => {
    function buildAssetForm(fields: Record<string, string> = {}) {
      const f = new FormData()
      f.append('name', 'Water heater')
      for (const [k, v] of Object.entries(fields)) f.append(k, v)
      return f
    }

    it('updates an asset scoped to the caller org', async () => {
      const supabase = makeSupabase({
        property_assets: [{ data: { asset_type: 'water_heater' }, error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateAsset('asset_1', 'prop_1', null, buildAssetForm())

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'asset.updated' }))
    })

    it('fails safely for an asset id whose org-scoped update matches zero rows (IDOR check)', async () => {
      const supabase = makeSupabase({
        property_assets: [{ data: null, error: { message: 'No rows found' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateAsset('other-orgs-asset', 'prop_1', null, buildAssetForm())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
    })
  })

  describe('deactivateAsset', () => {
    it('deactivates an asset scoped to the caller org', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await deactivateAsset('asset_1')

      expect(result).toEqual({})
      const eqCalls = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'asset.deactivated' }))
    })
  })

  describe('bulkImportAssets', () => {
    const rows: CsvAssetRow[] = [{
      name: 'Fridge', asset_type: 'refrigerator', make: null, model: null,
      serial_number: null, installation_date: null, purchase_price: null,
      estimated_replacement_cost: null, warranty_expiry_date: null,
      warranty_provider: null, notes: null,
    }]

    it('imports rows once the property is verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: 'prop_1' } }],
        asset_type_standards:  [{ data: [] }],
        property_assets:       [{ error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await bulkImportAssets('prop_1', rows)

      expect(result).toEqual({ imported: 1 })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'asset.bulk_imported' }))
    })

    // Regression test — bulkImportAssets previously inserted property_assets
    // rows using the caller's org_id but a client-supplied propertyId that
    // was never verified to belong to that org, unlike its sibling
    // createAsset() in this same file which does check. See CLAUDE.md's IDOR
    // standing-audit item; fixed in this session by adding the same
    // ownership check createAsset already had.
    it('rejects a property id that does not belong to the caller org (IDOR check — regression test for the fix in this session)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await bulkImportAssets('other-orgs-property', rows)

      expect(result).toEqual({ imported: 0, error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('property_assets')
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await bulkImportAssets('prop_1', rows)

      expect(result).toEqual({ imported: 0, error: 'Import failed — please try again' })
      expect(reportError).toHaveBeenCalled()
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('archiveProperty', () => {
    it('archives a property scoped to the caller org and redirects to /properties', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await expect(archiveProperty('prop_1')).rejects.toThrow('REDIRECT:/properties')

      const eqCalls = supabase.calls.filter((c) => c.table === 'properties' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'property.archived' }))
    })

    it('rejects and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(archiveProperty('prop_1')).rejects.toThrow('REDIRECT:/login')
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
