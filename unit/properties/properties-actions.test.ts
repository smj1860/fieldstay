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
  // Every mutating action in this file is now role-gated on admin|manager
  // (owner passes automatically) to match the properties/property_assets RLS
  // write policies and the door-code RPCs. markStepComplete deliberately keeps
  // requireOrgMember — see the comment on it in the action file.
  requireOrgMember: vi.fn(),
  requireOrgRole:   vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/geocoding', () => ({ geocodeZip: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/checklists/apply-master-template', () => ({
  applyMasterChecklistToProperty: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { geocodeZip } from '@/lib/geocoding'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { applyMasterChecklistToProperty } from '@/lib/checklists/apply-master-template'
import { inngest } from '@/lib/inngest/client'
import {
  createProperty,

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
    for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'in', 'not', 'is', 'limit', 'order', 'range']) {
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

// Both gates resolve to the same context: saveDetails-style actions call
// requireOrgRole, markStepComplete calls requireOrgMember.
function mockAuthed(supabase: ReturnType<typeof makeSupabase>) {
  const ctx = { supabase, membership, user: { id: 'user_1' } }
  vi.mocked(requireOrgMember).mockResolvedValue(ctx as never)
  vi.mocked(requireOrgRole).mockResolvedValue(ctx as never)
}

function mockAuthFailure(message: string) {
  vi.mocked(requireOrgMember).mockRejectedValue(new Error(message))
  vi.mocked(requireOrgRole).mockRejectedValue(new Error(message))
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
      mockAuthed(supabase)
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
      mockAuthed(supabase)

      const emptyForm = new FormData()
      const result = await createProperty(null, emptyForm)

      expect(result).toEqual({ error: 'Property name is required' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects once the org has reached its plan property limit', async () => {
      const supabase = makeSupabase({
        properties: [{ data: null, count: 25, error: null }],
      })
      mockAuthed(supabase)

      const result = await createProperty(null, fd())

      expect(result).toEqual({
        error: 'Your plan allows up to 25 properties. Upgrade to add more.',
      })
      expect(supabase.from).toHaveBeenCalledTimes(1)
    })

    it('rejects and never touches the DB when the caller is unauthenticated', async () => {
      mockAuthFailure('REDIRECT:/login')

      await expect(createProperty(null, fd())).rejects.toThrow('REDIRECT:/login')
    })

    // The property row is already committed by this point. An unguarded throw
    // skipped the redirect and returned "Operation failed" for a property that
    // EXISTS — so the PM retries and creates a duplicate. The door-code and
    // geocode writes on either side of it were already non-fatal for this
    // exact reason; the checklist apply was not.
    it('still redirects when the master checklist apply throws', async () => {
      const supabase = makeSupabase({
        properties: [
          { data: null, count: 0, error: null },
          { data: { id: 'prop_1' } },
        ],
      })
      mockAuthed(supabase)
      vi.mocked(applyMasterChecklistToProperty).mockRejectedValueOnce(new Error('template missing'))

      await expect(createProperty(null, fd()))
        .rejects.toThrow('REDIRECT:/properties/prop_1/setup/details')
    })
  })


  describe('revealPropertyDoorCode', () => {
    it('decrypts and returns the door code, auditing the reveal', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { id: 'prop_1', door_code_secret_id: 'secret_1' } }],
      })
      vi.mocked(supabase.rpc).mockResolvedValue({ data: '4821', error: null })
      mockAuthed(supabase)

      const result = await revealPropertyDoorCode('prop_1')

      expect(result).toEqual({ doorCode: '4821' })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'property.door_code.viewed' }))
    })

    it('returns null without calling the decrypt RPC when no door code is set', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { id: 'prop_1', door_code_secret_id: null } }],
      })
      mockAuthed(supabase)

      const result = await revealPropertyDoorCode('prop_1')

      expect(result).toEqual({ doorCode: null })
      expect(supabase.rpc).not.toHaveBeenCalled()
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      mockAuthed(supabase)

      const result = await revealPropertyDoorCode('other-orgs-property')

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.rpc).not.toHaveBeenCalled()
    })

    // A `viewer` could read the decrypted door code: the action gated on
    // requireOrgMember, and read_property_door_code's own guard was
    // get_user_org_ids() (any role). Both layers now require admin|manager.
    it('refuses to decrypt for a caller without the admin|manager role', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { id: 'prop_1', door_code_secret_id: 'secret_1' } }],
      })
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await revealPropertyDoorCode('prop_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.rpc).not.toHaveBeenCalled()
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('distinguishes a failed lookup from a property that simply has no row', async () => {
      const supabase = makeSupabase({
        properties: [{ data: null, error: { message: 'permission denied' } }],
      })
      mockAuthed(supabase)

      const result = await revealPropertyDoorCode('prop_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(reportError).toHaveBeenCalled()
      expect(supabase.rpc).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      mockAuthFailure('REDIRECT:/login')

      const result = await revealPropertyDoorCode('prop_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('markStepComplete', () => {
    it('marks a setup step complete through the atomic RPC, scoped to the caller org', async () => {
      const supabase = makeSupabase({})
      mockAuthed(supabase)
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { details: true, ical: true }, error: null })

      await expect(markStepComplete('prop_1', 'ical')).resolves.toBeUndefined()

      expect(supabase.rpc).toHaveBeenCalledWith('mark_property_setup_step', {
        p_property_id: 'prop_1',
        p_org_id:      'org_1',
        p_step:        'ical',
      })
    })

    // THE regression guard. This was a read, a JS spread, and a write-back.
    // That shape lost concurrent completions (both writers merged onto the
    // same snapshot) and, worse, collapsed a FAILED read to `{}` — so the
    // write-back erased every previously completed step while reporting
    // success. The merge now happens inside the UPDATE via jsonb `||`, so
    // there is no snapshot to go stale and no read to fail. If a separate
    // read of setup_steps_completed ever reappears here, both bugs are back.
    it('does not read setup_steps_completed separately — the merge is in the UPDATE', async () => {
      const supabase = makeSupabase({})
      mockAuthed(supabase)
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { ical: true }, error: null })

      await markStepComplete('prop_1', 'ical')

      const propertyReads = supabase.calls.filter(
        (c) => c.table === 'properties' && c.method === 'select' &&
               String(c.args[0]).includes('setup_steps_completed'),
      )
      expect(propertyReads).toHaveLength(0)
      expect(supabase.calls.filter((c) => c.table === 'properties' && c.method === 'update')).toHaveLength(0)
    })

    it('propagates the failure when the caller is unauthenticated', async () => {
      mockAuthFailure('boom')

      await expect(markStepComplete('prop_1', 'ical')).rejects.toThrow('boom')
    })

    // markStepComplete stays on requireOrgMember (five setup actions call it
    // after their own gated write). The RPC is SECURITY INVOKER, so RLS still
    // applies and a denied write returns NO ROW — which must fail closed
    // rather than mark the step complete in the UI.
    it('throws instead of reporting progress when the RPC matches 0 rows', async () => {
      const supabase = makeSupabase({})
      mockAuthed(supabase)
      vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null })

      await expect(markStepComplete('prop_1', 'ical')).rejects.toThrow(/permission/)
    })

    it('throws when the RPC itself errors', async () => {
      const supabase = makeSupabase({})
      mockAuthed(supabase)
      vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: { message: 'deadlock detected' } })

      await expect(markStepComplete('prop_1', 'ical')).rejects.toThrow(/setup progress/)
    })

    // The fully-set-up check reads the value the UPDATE actually wrote, not a
    // second query that could disagree with it.
    it('checks the org milestone off the merged value the RPC returned', async () => {
      const allDone = {
        details: true, ical: true, inventory: true, messages: true,
        checklist: true, maintenance: true, crew: true,
      }
      const supabase = makeSupabase({
        properties: [{ data: [{ id: 'prop_1', setup_steps_completed: allDone }, { id: 'prop_2', setup_steps_completed: allDone }] }],
      })
      mockAuthed(supabase)
      vi.mocked(supabase.rpc).mockResolvedValue({ data: allDone, error: null })

      await markStepComplete('prop_1', 'crew')

      expect(supabase.calls.some((c) => c.table === 'org_milestones' && c.method === 'upsert')).toBe(true)
    })

    it('does not reach for the milestone until the property is fully set up', async () => {
      const supabase = makeSupabase({})
      mockAuthed(supabase)
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { details: true, ical: true }, error: null })

      await markStepComplete('prop_1', 'ical')

      expect(supabase.calls.some((c) => c.table === 'org_milestones')).toBe(false)
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
      mockAuthed(supabase)

      const result = await createAsset('prop_1', null, buildAssetForm({ make: 'Rheem', model: 'XE50' }))

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'asset.created' }))
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'asset/manual_lookup.requested',
        data: { org_id: 'org_1', asset_type: 'water_heater', make: 'Rheem', model: 'XE50' },
      })
    })

    it('stores the nameplate year as manufacture_date, NOT as an in-service date', async () => {
      // The form used to pre-fill Installation Date from the scan's
      // manufacture_year, so an OCR guess landed in installation_date AND
      // placed_in_service_date — a tax field — indistinguishable from a date
      // the PM recorded. The year has its own column now; depreciation falls
      // back to it on its own and labels the entry when it does.
      const supabase = makeSupabase({
        properties:           [{ data: { id: 'prop_1' } }],
        asset_type_standards: [{ data: null }],
        property_assets:      [{ data: { id: 'asset_1' } }],
      })
      mockAuthed(supabase)

      await createAsset('prop_1', null, buildAssetForm({ manufacture_year: '2015' }))

      const insert = supabase.calls.find((c) => c.table === 'property_assets' && c.method === 'insert')
      expect(insert!.args[0]).toEqual(expect.objectContaining({
        manufacture_date:       '2015-01-01',
        installation_date:      null,
        placed_in_service_date: null,
      }))
    })

    it('rejects an implausible manufacture year rather than clamping it', async () => {
      // A clamped typo is a wrong number nobody is told about, and this value
      // reaches age scoring and, as a last resort, depreciation.
      const supabase = makeSupabase({})
      mockAuthed(supabase)

      const result = await createAsset('prop_1', null, buildAssetForm({ manufacture_year: '215' }))

      expect(result.error).toMatch(/Manufacture year must be between 1900 and \d{4}/)
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('accepts a blank manufacture year as simply absent', async () => {
      const supabase = makeSupabase({
        properties:           [{ data: { id: 'prop_1' } }],
        asset_type_standards: [{ data: null }],
        property_assets:      [{ data: { id: 'asset_1' } }],
      })
      mockAuthed(supabase)

      const result = await createAsset('prop_1', null, buildAssetForm({ manufacture_year: '' }))

      expect(result).toEqual({ success: true })
      const insert = supabase.calls.find((c) => c.table === 'property_assets' && c.method === 'insert')
      expect(insert!.args[0]).toEqual(expect.objectContaining({ manufacture_date: null }))
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      mockAuthed(supabase)

      const result = await createAsset('other-orgs-property', null, buildAssetForm())

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('property_assets')
    })

    it('rejects when required fields are missing', async () => {
      const supabase = makeSupabase({})
      mockAuthed(supabase)

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
      mockAuthed(supabase)

      const result = await updateAsset('asset_1', 'prop_1', null, buildAssetForm())

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'asset.updated' }))
    })

    it('fails safely for an asset id whose org-scoped update matches zero rows (IDOR check)', async () => {
      const supabase = makeSupabase({
        property_assets: [{ data: null, error: { message: 'No rows found' } }],
      })
      mockAuthed(supabase)

      const result = await updateAsset('other-orgs-asset', 'prop_1', null, buildAssetForm())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
    })
  })

  describe('deactivateAsset', () => {
    it('deactivates an asset scoped to the caller org', async () => {
      const supabase = makeSupabase({
        property_assets: [{ data: { id: 'asset_1' }, error: null }],
      })
      mockAuthed(supabase)

      const result = await deactivateAsset('asset_1')

      expect(result).toEqual({})
      const eqCalls = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'asset.deactivated' }))
    })

    it('reports a permission failure when the update matches 0 rows', async () => {
      const supabase = makeSupabase({
        property_assets: [{ data: null, error: null }],
      })
      mockAuthed(supabase)

      const result = await deactivateAsset('other-orgs-asset')

      expect(result.error).toContain('permission')
      expect(logAuditEvent).not.toHaveBeenCalled()
    })
  })

  // Every numeric field here reached the DB through `parseFloat(x) || fallback`
  // or `x ? parseFloat(x) : null`, neither of which is validation: `|| f`
  // catches NaN and 0 but passes NEGATIVES (truthy), and the bare ternary
  // passes NaN and ±Infinity, which supabase-js serializes to `null`.
  // purchase_price and estimated_replacement_cost feed MACRS depreciation and
  // calculateHealthScore.
  describe('numeric input validation', () => {
    function assetForm(fields: Record<string, string>) {
      const f = new FormData()
      f.append('name', 'Water heater')
      f.append('asset_type', 'water_heater')
      for (const [k, v] of Object.entries(fields)) f.append(k, v)
      return f
    }

    it.each([
      ['negative',  '-500'],
      ['NaN',       'abc'],
      ['Infinity',  'Infinity'],
      ['over $1M',  '5000000'],
    ])('rejects a %s purchase price before any write', async (_label, value) => {
      const supabase = makeSupabase({})
      mockAuthed(supabase)

      const result = await createAsset('prop_1', null, assetForm({ purchase_price: value }))

      expect(result.error).toMatch(/Purchase price/)
      expect(supabase.from).not.toHaveBeenCalled()
    })

    // `expected_lifespan_years ?? standardsMidpoint` could never recover from a
    // bad value: parseInt('abc') is NaN, and NaN is neither null nor undefined,
    // so `??` handed it straight through and the standards default — the whole
    // point of the fallback — was skipped.
    it('rejects a non-numeric lifespan rather than letting NaN defeat the ?? default', async () => {
      const supabase = makeSupabase({})
      mockAuthed(supabase)

      const result = await createAsset('prop_1', null, assetForm({ expected_lifespan_years: 'abc' }))

      expect(result.error).toMatch(/lifespan/i)
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects a negative nightly rate on the property form', async () => {
      const supabase = makeSupabase({})
      mockAuthed(supabase)

      const result = await createProperty(null, fd({ avg_nightly_rate: '-250' }))

      expect(result.error).toMatch(/Nightly rate/)
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('clamps a negative bedroom count to the default instead of storing it', async () => {
      const supabase = makeSupabase({
        properties: [{ data: null, count: 0, error: null }, { data: { id: 'prop_1' } }],
      })
      mockAuthed(supabase)

      await expect(createProperty(null, fd({ bedrooms: '-5', max_guests: '-2' })))
        .rejects.toThrow('REDIRECT:/properties/prop_1/setup/details')

      const insert = supabase.calls.find((c) => c.table === 'properties' && c.method === 'insert')
      expect(insert!.args[0]).toEqual(expect.objectContaining({ bedrooms: 1, max_guests: 2 }))
    })
  })

  describe('bulkImportAssets', () => {
    const rows: CsvAssetRow[] = [{
      name: 'Fridge', asset_type: 'refrigerator', make: null, model: null,
      serial_number: null, installation_date: null, manufacture_date: null, purchase_price: null,
      estimated_replacement_cost: null, warranty_expiry_date: null,
      warranty_provider: null, notes: null,
    }]

    it('imports rows once the property is verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: 'prop_1' } }],
        asset_type_standards:  [{ data: [] }],
        property_assets:       [{ error: null }],
      })
      mockAuthed(supabase)

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
      mockAuthed(supabase)

      const result = await bulkImportAssets('other-orgs-property', rows)

      expect(result).toEqual({ imported: 0, error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('property_assets')
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      mockAuthFailure('REDIRECT:/login')

      const result = await bulkImportAssets('prop_1', rows)

      expect(result).toEqual({ imported: 0, error: 'Import failed — please try again' })
      expect(reportError).toHaveBeenCalled()
      expect(supabase.from).not.toHaveBeenCalled()
    })
    it('refuses an import larger than the row cap before any insert', async () => {
      const supabase = makeSupabase({ properties: [{ data: { id: 'prop_1' } }] })
      mockAuthed(supabase)
      const many = Array.from({ length: 501 }, () => rows[0]!)

      const result = await bulkImportAssets('prop_1', many)

      expect(result.imported).toBe(0)
      expect(result.error).toMatch(/limited to 500 rows/)
      expect(supabase.calls.some((c) => c.table === 'property_assets')).toBe(false)
    })

    it('names the offending row when a price is not a finite non-negative number', async () => {
      const supabase = makeSupabase({ properties: [{ data: { id: 'prop_1' } }] })
      mockAuthed(supabase)

      const result = await bulkImportAssets('prop_1', [
        rows[0]!,
        { ...rows[0]!, purchase_price: -1 },
      ])

      expect(result.imported).toBe(0)
      expect(result.error).toMatch(/Row 2/)
      expect(supabase.calls.some((c) => c.table === 'property_assets')).toBe(false)
    })
  })

  describe('archiveProperty', () => {
    it('archives a property scoped to the caller org and redirects to /properties', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { id: 'prop_1' }, error: null }],
      })
      mockAuthed(supabase)

      await expect(archiveProperty('prop_1')).rejects.toThrow('REDIRECT:/properties')

      const eqCalls = supabase.calls.filter((c) => c.table === 'properties' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'property.archived' }))
    })

    it('throws instead of redirecting as if archived when the update matches 0 rows', async () => {
      const supabase = makeSupabase({
        properties: [{ data: null, error: null }],
      })
      mockAuthed(supabase)

      // The outer catch deliberately replaces the message with a generic one
      // (details-form.tsx surfaces e.message directly to the PM). What matters
      // is that it throws at all instead of redirecting to /properties as if
      // the archive had happened.
      await expect(archiveProperty('other-orgs-property'))
        .rejects.toThrow('Failed to archive property. Please try again.')
      expect(mockRedirect).not.toHaveBeenCalled()
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('rejects and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      mockAuthFailure('REDIRECT:/login')

      await expect(archiveProperty('prop_1')).rejects.toThrow('REDIRECT:/login')
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
