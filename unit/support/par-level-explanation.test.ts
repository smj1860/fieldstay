import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

const from = vi.fn()
const rpc  = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from, rpc }),
}))

import { getParLevelExplanation, callAccountTool, ACCOUNT_TOOLS } from '@/lib/support/account-tools'

// ============================================================================
// "Why is my washcloth par 16?" — a question the help docs structurally cannot
// answer, because the number depends on that property's bathroom count, the
// item's base quantity, whether the PM re-based it, and how many consumption
// samples exist. Hence a tool rather than another paragraph.
//
// The two things that must hold:
//   1. The explanation is PLAIN ENGLISH, written server-side. A PM asking this
//      does not want base_qty and a buffer coefficient. Handing the model a
//      finished sentence also stops it inventing arithmetic.
//   2. The model-supplied search term NARROWS an org-scoped query and can
//      never widen it. orgId comes from the session, never from the tool call.
// ============================================================================

const ORG = 'org-1'

interface Chain { [k: string]: unknown }
function mockQuery(items: unknown[], stats: unknown[] = []) {
  const calls: { method: string; args: unknown[] }[] = []
  let nth = 0
  from.mockImplementation(() => {
    const payload = nth++ === 0 ? items : stats
    const chain: Chain = {}
    for (const m of ['select', 'eq', 'in', 'ilike']) {
      chain[m] = vi.fn((...args: unknown[]) => { calls.push({ method: m, args }); return chain })
    }
    chain.limit = vi.fn((...args: unknown[]) => {
      calls.push({ method: 'limit', args })
      return Promise.resolve({ data: payload, error: null })
    })
    return chain
  })
  rpc.mockResolvedValue({ data: [], error: null })
  return calls
}

const ITEM = (over: Record<string, unknown> = {}) => ({
  id: 'i-1', name: 'Washcloths', par_level: 12, par_mode: 'smart',
  smart_group: 'bathroom_essential', base_qty: 5, auto_adjust: true,
  property_id: 'p-1',
  properties: [{ name: 'Majestic Shores', bedrooms: 1, bathrooms: 2, max_guests: 4 }],
  ...over,
})

describe('getParLevelExplanation', () => {
  beforeEach(() => { vi.clearAllMocks(); from.mockReset(); rpc.mockReset() })

  it('explains a scaling par in words a non-technical PM can act on', async () => {
    mockQuery([ITEM()])
    const res = await getParLevelExplanation(ORG, 'washcloth')
    const item = (res as { items: { explanation: string; setBy: string; whatChangesIt: string }[] }).items[0]

    expect(item.setBy).toBe('scales with bathrooms')
    expect(item.explanation).toContain('The par level is 12')
    expect(item.explanation).toContain("property's bathrooms")
    expect(item.explanation).toContain('this one has 2')
    expect(item.explanation).toContain('per bathroom')
    expect(item.whatChangesIt).toContain('bathrooms')

    // No jargon reaches the PM. These are the words the tool exists to avoid.
    for (const jargon of ['base_qty', 'smart_group', 'par_mode', 'multiplier', 'auto_adjust', 'buffer coefficient']) {
      expect(item.explanation).not.toContain(jargon)
    }
  })

  it('never produces mangled plurals for guest-scaled items', async () => {
    // "guest capacity" is not the plural of "guest". Deriving the singular by
    // stripping a trailing "s" produced "about 4.5 per guests it sleep" in
    // review, which is why plural and singular are stored separately.
    mockQuery([ITEM({ smart_group: 'guest_consumable', par_level: 18, name: 'Creamer Cups' })])
    const res = await getParLevelExplanation(ORG)
    const item = (res as { items: { explanation: string }[] }).items[0]

    expect(item.explanation).toContain('per guest,')
    expect(item.explanation).not.toContain('guests it sleep')
    expect(item.explanation).not.toMatch(/per \w+s,/)   // never a plural after "per"
  })

  it('says a PM-set level is theirs, and a default is FieldStay\'s', async () => {
    mockQuery([ITEM({ auto_adjust: false, par_level: 16 })])
    const set = await getParLevelExplanation(ORG)
    expect((set as { items: { explanation: string }[] }).items[0].explanation)
      .toContain('You set this level yourself')

    mockQuery([ITEM({ auto_adjust: true })])
    const dflt = await getParLevelExplanation(ORG)
    expect((dflt as { items: { explanation: string }[] }).items[0].explanation)
      .toContain('FieldStay default')
  })

  it('describes a fixed item as fixed rather than inventing a scale', async () => {
    mockQuery([ITEM({ par_mode: 'static', smart_group: null, par_level: 4 })])
    const res = await getParLevelExplanation(ORG)
    const item = (res as { items: { setBy: string; explanation: string }[] }).items[0]
    expect(item.setBy).toBe('fixed number')
    expect(item.explanation).toContain('does not scale')
  })

  it('scopes to the caller\'s org and only NARROWS with the search term', async () => {
    // The search term is the one model-supplied argument in the whole tool
    // surface. It must be a filter on an already org-scoped query.
    const calls = mockQuery([ITEM()])
    await getParLevelExplanation(ORG, 'washcloth')

    expect(calls).toContainEqual({ method: 'eq', args: ['org_id', ORG] })
    expect(calls).toContainEqual({ method: 'ilike', args: ['name', '%washcloth%'] })
  })

  it('returns a clear miss rather than the whole portfolio when nothing matches', async () => {
    mockQuery([])
    const res = await getParLevelExplanation(ORG, 'nonexistent')
    expect(res).toMatchObject({ matched: 0, items: [] })
    expect((res as { note: string }).note).toContain('nonexistent')
  })
})

describe('callAccountTool — par explanation dispatch', () => {
  beforeEach(() => { vi.clearAllMocks(); from.mockReset(); rpc.mockReset() })

  it('is registered with a schema the model can actually call', () => {
    const tool = ACCOUNT_TOOLS.find((t) => t.name === 'get_par_level_explanation')
    expect(tool).toBeDefined()
    expect(tool!.input_schema.properties).toHaveProperty('item_name')
  })

  it('ignores a non-string item_name instead of coercing it into the query', async () => {
    // The model can emit anything. String(x) on an object gives
    // "[object Object]", which would silently search for that literal and
    // return "no items matching" for a question about a real one.
    const calls = mockQuery([ITEM()])
    await callAccountTool('get_par_level_explanation', ORG, { item_name: { nested: true } })
    // ilike is always applied — an empty term is '%%', which matches all.
    expect(calls.find((c) => c.method === 'ilike')!.args[1]).toBe('%%')
  })

  it('caps an over-long search term', async () => {
    const calls = mockQuery([ITEM()])
    await callAccountTool('get_par_level_explanation', ORG, { item_name: 'x'.repeat(5000) })
    const ilike = calls.find((c) => c.method === 'ilike')
    expect((ilike!.args[1] as string).length).toBeLessThanOrEqual(102)
  })

  it('escapes LIKE metacharacters so a lone % cannot match every item', async () => {
    // Same defect app/actions/work-order-public.ts records: an unescaped '%'
    // matched every vendor in the org. Here it would describe the whole
    // portfolio while appearing to answer about one item.
    const calls = mockQuery([ITEM()])
    await callAccountTool('get_par_level_explanation', ORG, { item_name: '%' })
    expect(calls.find((c) => c.method === 'ilike')!.args[1]).toBe('%\\%%')
  })
})
