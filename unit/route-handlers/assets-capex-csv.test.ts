import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))

import { GET } from '@/app/api/assets/capex-csv/route'
import { requireOrgMember } from '@/lib/auth'
import type { CapExProjectionPayload } from '@/lib/inngest/functions/capex-projections'

const ORG_ID = 'org_1'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    return chain
  })
  return { from, calls }
}

function mockAuthed(supabase: ReturnType<typeof makeSupabase>) {
  vi.mocked(requireOrgMember).mockResolvedValue({
    user:       { id: 'user_1' } as never,
    supabase:   supabase as never,
    membership: { org_id: ORG_ID, role: 'admin', org: {} as never },
  } as never)
}

function getRequest(query = '') {
  return new Request(`http://localhost/api/assets/capex-csv${query}`)
}

describe('GET /api/assets/capex-csv', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('propagates the redirect when the caller is not an authenticated org member', async () => {
    vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

    await expect(GET(getRequest())).rejects.toThrow('REDIRECT:/login')
  })

  it('returns just the header row when no projection milestone exists yet for the year', async () => {
    const supabase = makeSupabase({ org_milestones: [{ data: null, error: null }] })
    mockAuthed(supabase)

    const res = await GET(getRequest('?year=2025'))
    const csv = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="capex-forecast-2025.csv"')
    expect(csv.trim()).toBe(
      'Replacement Year,Property,Asset,Asset Type,Age (Years),% of Lifespan,Health Score,Cost Low,Cost High'
    )
  })

  it('scopes the milestone lookup to the caller\'s own org_id and the requested year', async () => {
    const supabase = makeSupabase({ org_milestones: [{ data: null, error: null }] })
    mockAuthed(supabase)

    await GET(getRequest('?year=2030'))

    const eqCalls = supabase.calls.filter((c) => c.table === 'org_milestones' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    expect(eqCalls.some((c) => c.args[0] === 'milestone' && c.args[1] === 'capex_projection_2030')).toBe(true)
  })

  it('defaults to the current year when no year query param is given', async () => {
    const supabase = makeSupabase({ org_milestones: [{ data: null, error: null }] })
    mockAuthed(supabase)

    const res = await GET(getRequest())

    const currentYear = new Date().getFullYear()
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="capex-forecast-${currentYear}.csv"`)
    const eqCalls = supabase.calls.filter((c) => c.table === 'org_milestones' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'milestone' && c.args[1] === `capex_projection_${currentYear}`)).toBe(true)
  })

  it('renders every projection year sorted ascending, with CSV-escaped quotes in names', async () => {
    const payload: CapExProjectionPayload = {
      generated_at: '2026-01-01T00:00:00Z',
      projections: {
        2027: {
          total_low: 500, total_high: 800,
          items: [{
            asset_id: 'asset_2', asset_name: 'Roof', property_id: 'prop_1',
            property_name: 'Lakeview "Cabin"', asset_type: 'roof',
            replacement_year: 2027, cost_low: 500, cost_high: 800,
            health_score: 40, age_years: 20, pct_of_lifespan: 90,
          }],
        },
        2025: {
          total_low: 100, total_high: 200,
          items: [{
            asset_id: 'asset_1', asset_name: 'HVAC Unit', property_id: 'prop_1',
            property_name: 'Lakeview Cabin', asset_type: 'hvac',
            replacement_year: 2025, cost_low: 100, cost_high: 200,
            health_score: null, age_years: 15, pct_of_lifespan: 95,
          }],
        },
      },
    }
    const supabase = makeSupabase({ org_milestones: [{ data: { value: payload }, error: null }] })
    mockAuthed(supabase)

    const res = await GET(getRequest())
    const rows = (await res.text()).trim().split('\n')

    // 2025 (lower year) sorts before 2027, regardless of object key insertion order
    expect(rows[1]).toBe('2025,"Lakeview Cabin","HVAC Unit",hvac,15,95%,,100,200')
    // Embedded double-quote in the property name is escaped per RFC 4180
    expect(rows[2]).toBe('2027,"Lakeview ""Cabin""","Roof",roof,20,90%,40,500,800')
  })
})
