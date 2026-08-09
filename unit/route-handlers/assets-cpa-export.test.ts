import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', async () => {
  // Routes under test now consult a limiter via checkLimit(). Mocked so the
  // suite never attempts a real Upstash round trip.
  const { checkLimitStub, retryAfterSecondsStub } = await import('@/unit/stubs/rate-limit')
  return {
    dataExportLimiter: { limit: vi.fn(async () => ({ success: true })) },
    checkLimit:        checkLimitStub(),
    retryAfterSeconds: retryAfterSecondsStub,
  }
})
vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { GET } from '@/app/api/assets/cpa-export/route'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'

const ORG_ID = 'org_1'

// `count` is what a `{ count: 'exact', head: true }` read resolves with —
// no rows at all, just the total.
type Resp = { data?: unknown; error?: unknown; count?: number }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'order', 'range']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

function mockAuthed() {
  vi.mocked(requireOrgMember).mockResolvedValue({
    user:       { id: 'user_1' } as never,
    supabase:   {} as never,
    membership: { org_id: ORG_ID, role: 'admin', org: {} as never },
  } as never)
}

function baseEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'entry_1', asset_id: 'asset_1', tax_year: 2025, macrs_class: '5_year',
    cost_basis: 1000, prior_cumulative_depreciation: 200,
    current_year_depreciation: 200, ending_adjusted_basis: 600,
    depreciation_rate: 0.2,
    property_assets: {
      name: 'HVAC Unit', placed_in_service_date: '2020-01-01', property_id: 'prop_1',
      properties: { name: 'Lakeview Cabin' },
    },
    ...overrides,
  }
}

function getRequest(query = '') {
  return new Request(`http://localhost/api/assets/cpa-export${query}`)
}

describe('GET /api/assets/cpa-export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('propagates the redirect when the caller is not an authenticated org member', async () => {
    vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

    await expect(GET(getRequest())).rejects.toThrow('REDIRECT:/login')
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 404 when there are no depreciation entries for the tax year', async () => {
    mockAuthed()
    const supabase = makeSupabase({
      organizations:               [{ data: { name: 'Lake Martin Delivery' }, error: null }],
      // The head-count guard consumes the first slot, then the entries read.
      asset_depreciation_entries:  [{ count: 0, error: null }, { data: [], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await GET(getRequest('?tax_year=2025'))

    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toContain('2025')
  })

  it('scopes both the org name lookup and the entries query to the caller\'s own org_id — never another org\'s ledger', async () => {
    mockAuthed()
    const supabase = makeSupabase({
      organizations:              [{ data: { name: 'Lake Martin Delivery' }, error: null }],
      asset_depreciation_entries: [{ count: 1, error: null }, { data: [baseEntry()], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    await GET(getRequest('?tax_year=2025'))

    const orgEq = supabase.calls.filter((c) => c.table === 'organizations' && c.method === 'eq')
    expect(orgEq.some((c) => c.args[0] === 'id' && c.args[1] === ORG_ID)).toBe(true)

    const entriesEq = supabase.calls.filter((c) => c.table === 'asset_depreciation_entries' && c.method === 'eq')
    expect(entriesEq.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    expect(entriesEq.some((c) => c.args[0] === 'tax_year' && c.args[1] === 2025)).toBe(true)
  })

  it('refuses an export too large to build synchronously, with a count that never ships rows', async () => {
    // Everything after the read is synchronous CPU on the REQUEST path — reduce
    // passes, per-row pdf-lib draws, one save() that serialises the whole
    // document, no yield point — and this route has no maxDuration entry in
    // vercel.json. Past the ceiling the honest answer is a clear 413, not a
    // request killed mid-serialisation with nothing to explain it.
    mockAuthed()
    const supabase = makeSupabase({
      organizations:              [{ data: { name: 'Lake Martin Delivery' }, error: null }],
      asset_depreciation_entries: [{ count: 25_000, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await GET(getRequest('?tax_year=2025'))

    expect(res.status).toBe(413)
    expect((await res.json()).error).toContain('25,000')

    // head: true — the guard must not drag 25,000 joined rows over the wire to
    // discover it should not have.
    const countCall = supabase.calls.find(
      (c) => c.table === 'asset_depreciation_entries' && c.method === 'select',
    )
    expect(countCall?.args[1]).toMatchObject({ count: 'exact', head: true })
  })

  it('generates a depreciation-schedule PDF for a caller with entries in the given tax year', async () => {
    mockAuthed()
    const supabase = makeSupabase({
      organizations:              [{ data: { name: 'Lake Martin Delivery' }, error: null }],
      asset_depreciation_entries: [{ count: 2, error: null }, {
        data: [
          baseEntry(),
          baseEntry({
            id: 'entry_2', asset_id: 'asset_2', cost_basis: 2000,
            current_year_depreciation: 400, ending_adjusted_basis: 1600,
            property_assets: {
              name: 'Roof', placed_in_service_date: '2019-06-01', property_id: 'prop_2',
              properties: { name: 'Sunset Villa' },
            },
          }),
        ],
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await GET(getRequest('?tax_year=2025'))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="depreciation-schedule-2025.pdf"')
    expect(Number(res.headers.get('Content-Length'))).toBeGreaterThan(0)

    const buffer = Buffer.from(await res.arrayBuffer())
    // %PDF- magic bytes confirm pdf-lib actually produced a real PDF
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-')
  })

  it('defaults to last year when no tax_year query param is given', async () => {
    mockAuthed()
    const supabase = makeSupabase({
      organizations:              [{ data: { name: 'Lake Martin Delivery' }, error: null }],
      asset_depreciation_entries: [{ data: [], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const lastYear = new Date().getFullYear() - 1
    const res = await GET(getRequest())
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toContain(String(lastYear))
  })
})
