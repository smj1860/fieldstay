import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

vi.mock('@/lib/crew-auth', () => ({
  requireCrewMember: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(),
}))

import { POST } from '@/app/api/crew/inventory-count/route'
import { requireCrewMember } from '@/lib/crew-auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvents } from '@/lib/audit'

const CREW_ID  = 'crew_1'
const ORG_ID   = 'org_1'
const USER_ID  = 'user_1'
const PROP_ID  = 'property_1'

type QueuedByTable = Record<string, Array<{ data?: unknown; error?: unknown }>>

// See unit/settings/team-actions.test.ts for the pattern this mirrors —
// extended with .in/.gte/.maybeSingle for this route's queries.
function makeSupabase(queued: QueuedByTable = {}) {
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
    chain.insert = (...a: unknown[]) => record('insert', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.gte    = (...a: unknown[]) => record('gte', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function mockAuthed(supabase: ReturnType<typeof makeSupabase>) {
  vi.mocked(requireCrewMember).mockResolvedValue({
    ok:       true,
    user:     { id: USER_ID },
    supabase: supabase as never,
    crew:     { id: CREW_ID, org_id: ORG_ID },
  })
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/crew/inventory-count', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

describe('POST /api/crew/inventory-count', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the auth helper response verbatim when the caller is not a valid crew member', async () => {
    vi.mocked(requireCrewMember).mockResolvedValue({
      ok:       false,
      response: NextResponse.json({ error: 'Crew member not found' }, { status: 403 }),
    })

    const res = await POST(postRequest({ propertyId: PROP_ID, counts: {}, notes: '' }))

    expect(res.status).toBe(403)
  })

  it('rejects a propertyId that does not belong to the crew member\'s org (IDOR)', async () => {
    const supabase = makeSupabase({ properties: [{ data: null, error: null }] })
    mockAuthed(supabase)

    const res = await POST(postRequest({ propertyId: 'other_org_property', counts: {}, notes: '' }))

    expect(res.status).toBe(404)
    const eqCalls = supabase.calls.filter((c) => c.table === 'properties' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    expect(eqCalls.some((c) => c.args[0] === 'id' && c.args[1] === 'other_org_property')).toBe(true)
    expect(supabase.calls.some((c) => c.table === 'inventory_count_drafts')).toBe(false)
    expect(supabase.calls.some((c) => c.table === 'inventory_counts')).toBe(false)
  })

  describe('draft submission (submitAsDraft: true)', () => {
    it('creates a draft scoped to the crew member\'s own org and id', async () => {
      const supabase = makeSupabase({
        properties:                [{ data: { id: PROP_ID }, error: null }],
        inventory_count_drafts:    [{ data: null, error: null }, { data: { id: 'draft_1' }, error: null }],
        inventory_items:           [{ data: [{ id: 'item_1', current_quantity: 4 }], error: null }],
        inventory_count_draft_items: [{ data: null, error: null }],
      })
      mockAuthed(supabase)

      const res = await POST(
        postRequest({
          propertyId:    PROP_ID,
          counts:        { item_1: 2 },
          notes:         'low on paper towels',
          itemNotes:     { item_1: 'almost out' },
          submitAsDraft: true,
        }),
      )

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true, draftId: 'draft_1' })

      const draftInsert = supabase.calls.find((c) => c.table === 'inventory_count_drafts' && c.method === 'insert')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inserted = draftInsert!.args[0] as any
      expect(inserted).toEqual({
        org_id:       ORG_ID,
        property_id:  PROP_ID,
        submitted_by: CREW_ID,
        status:       'pending_review',
        notes:        'low on paper towels',
      })

      const itemsInsert = supabase.calls.find(
        (c) => c.table === 'inventory_count_draft_items' && c.method === 'insert',
      )
      expect(itemsInsert!.args[0]).toEqual([
        {
          draft_id:          'draft_1',
          item_id:           'item_1',
          previous_quantity: 4,
          counted_qty:       2,
          notes:             'almost out',
        },
      ])
    })

    it('short-circuits on a recent duplicate draft (double-tap dedup) without creating a new one', async () => {
      const supabase = makeSupabase({
        properties:             [{ data: { id: PROP_ID }, error: null }],
        inventory_count_drafts: [{ data: { id: 'existing_draft' }, error: null }],
      })
      mockAuthed(supabase)

      const res = await POST(
        postRequest({ propertyId: PROP_ID, counts: { item_1: 2 }, notes: '', submitAsDraft: true }),
      )

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true, draftId: 'existing_draft' })
      expect(supabase.calls.some((c) => c.table === 'inventory_count_drafts' && c.method === 'insert')).toBe(false)
    })

    it('returns 500 when the draft insert fails to return a row', async () => {
      const supabase = makeSupabase({
        properties:             [{ data: { id: PROP_ID }, error: null }],
        inventory_count_drafts: [{ data: null, error: null }, { data: null, error: { message: 'fail' } }],
        inventory_items:        [{ data: [], error: null }],
      })
      mockAuthed(supabase)

      const res = await POST(
        postRequest({ propertyId: PROP_ID, counts: {}, notes: '', submitAsDraft: true }),
      )

      expect(res.status).toBe(500)
    })
  })

  describe('legacy direct-commit path', () => {
    it('commits counts, updates inventory scoped to the crew member\'s org, audits, and notifies Inngest', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: PROP_ID }, error: null }],
        inventory_counts:      [{ data: null, error: null }, { data: { id: 'count_1' }, error: null }],
        inventory_count_items: [{ data: null, error: null }],
        inventory_items:       [{ data: null, error: null }],
      })
      mockAuthed(supabase)

      const res = await POST(
        postRequest({ propertyId: PROP_ID, counts: { item_1: 5 }, notes: 'weekly count' }),
      )

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true })

      const countInsert = supabase.calls.find((c) => c.table === 'inventory_counts' && c.method === 'insert')
      expect(countInsert!.args[0]).toEqual({
        property_id:          PROP_ID,
        org_id:                ORG_ID,
        submitted_by_crew_id: CREW_ID,
        notes:                'weekly count',
      })

      // The item update must be scoped to the crew member's own org_id —
      // an item id belonging to another org's inventory cannot be touched.
      const updateEq = supabase.calls.filter((c) => c.table === 'inventory_items' && c.method === 'eq')
      expect(updateEq.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
      expect(updateEq.some((c) => c.args[0] === 'id' && c.args[1] === 'item_1')).toBe(true)

      expect(logAuditEvents).toHaveBeenCalledWith([
        expect.objectContaining({
          actorId: USER_ID,
          orgId:   ORG_ID,
          action:  'inventory.count_committed',
          targetId: 'item_1',
        }),
      ])

      expect(inngest.send).toHaveBeenCalledWith({
        name: 'inventory/count-submitted',
        data: { count_id: 'count_1', property_id: PROP_ID, org_id: ORG_ID },
      })
    })

    it('short-circuits on a recent duplicate commit (double-tap dedup)', async () => {
      const supabase = makeSupabase({
        properties:       [{ data: { id: PROP_ID }, error: null }],
        inventory_counts: [{ data: { id: 'existing_count' }, error: null }],
      })
      mockAuthed(supabase)

      const res = await POST(postRequest({ propertyId: PROP_ID, counts: { item_1: 5 }, notes: '' }))

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true })
      expect(supabase.calls.some((c) => c.table === 'inventory_counts' && c.method === 'insert')).toBe(false)
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('returns 500 when the count insert fails to return a row', async () => {
      const supabase = makeSupabase({
        properties:       [{ data: { id: PROP_ID }, error: null }],
        inventory_counts: [{ data: null, error: null }, { data: null, error: { message: 'fail' } }],
      })
      mockAuthed(supabase)

      const res = await POST(postRequest({ propertyId: PROP_ID, counts: {}, notes: '' }))

      expect(res.status).toBe(500)
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })
})
