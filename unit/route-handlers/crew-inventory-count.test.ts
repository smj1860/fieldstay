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
// inventory_items.id is a uuid column; the route validates the shape at the
// boundary precisely so a non-uuid never reaches `.in('id', …)`, where it
// raises 22P02 and 500-loops in the crew outbox forever.
const ITEM_ID  = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

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
    // This read paginates via fetchAllRows(), which drains .order().range().
    chain.order  = (...a: unknown[]) => record('order', a)
    chain.range  = (...a: unknown[]) => record('range', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.gte    = (...a: unknown[]) => record('gte', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)

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
    expect(supabase.calls.some((c) => c.table === 'inventory_counts')).toBe(false)
  })


  describe('count submission', () => {
    it('commits counts, updates inventory scoped to the crew member\'s org, audits, and notifies Inngest', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: PROP_ID }, error: null }],
        inventory_counts:      [{ data: null, error: null }, { data: { id: 'count_1' }, error: null }],
        inventory_count_items: [{ data: null, error: null }],
        inventory_items:       [{ data: [{ id: ITEM_ID }], error: null }, { data: null, error: null }],
      })
      mockAuthed(supabase)

      const res = await POST(
        postRequest({ propertyId: PROP_ID, counts: { [ITEM_ID]: 5 }, notes: 'weekly count' }),
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
      expect(updateEq.some((c) => c.args[0] === 'id' && c.args[1] === ITEM_ID)).toBe(true)

      expect(logAuditEvents).toHaveBeenCalledWith([
        expect.objectContaining({
          actorId: USER_ID,
          orgId:   ORG_ID,
          action:  'inventory.count_committed',
          targetId: ITEM_ID,
        }),
      ])

      expect(inngest.send).toHaveBeenCalledWith({
        id:   'inventory-count-submitted:count_1',
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

      const res = await POST(postRequest({ propertyId: PROP_ID, counts: { [ITEM_ID]: 5 }, notes: '' }))

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true })
      expect(supabase.calls.some((c) => c.table === 'inventory_counts' && c.method === 'insert')).toBe(false)
      // The event IS re-sent, and this assertion used to say the opposite.
      // If the first attempt committed the count and applied the quantities
      // but then failed at inngest.send(), the device retried, landed here,
      // and got a bare success — so the restock (purchase order, PM email,
      // cart) was lost permanently while the crew was told it worked. The
      // explicit event id lets Inngest collapse the duplicate delivery.
      expect(inngest.send).toHaveBeenCalledWith({
        id:   'inventory-count-submitted:existing_count',
        name: 'inventory/count-submitted',
        data: { count_id: 'existing_count', property_id: PROP_ID, org_id: ORG_ID },
      })
    })

    // `counts` is `Record<string, number>` only as a TypeScript assertion over
    // request.json(). quantity_counted is `integer NOT NULL`, so anything else
    // reached Postgres, raised 22P02/22003, and earned a 500 — which
    // lib/dexie/net.ts treats as TRANSIENT, so the submission retried FOREVER.
    // A poison pill that never drains, keeps the logout "unsynced work"
    // warning armed permanently, and is invisible to the dead-letter banner
    // because a transport failure never sets the `failed` flag.
    it.each([
      ['a non-uuid item id',   { not_a_uuid: 5 }],
      ['a string quantity',    { '3f2504e0-4f89-41d3-9a0c-0305e82c3301': '5' }],
      ['a fractional quantity',{ '3f2504e0-4f89-41d3-9a0c-0305e82c3301': 2.5 }],
      ['a negative quantity',  { '3f2504e0-4f89-41d3-9a0c-0305e82c3301': -1 }],
      ['NaN',                  { '3f2504e0-4f89-41d3-9a0c-0305e82c3301': Number.NaN }],
      ['an array',             [] as unknown],
    ])('rejects %s with a terminal 400 rather than a 500 the outbox retries forever', async (_label, counts) => {
      const supabase = makeSupabase({ properties: [{ data: { id: PROP_ID }, error: null }] })
      mockAuthed(supabase)

      const res = await POST(postRequest({ propertyId: PROP_ID, counts, notes: '' }))

      expect(res.status).toBe(400)
      expect(supabase.calls.some((c) => c.table === 'inventory_counts')).toBe(false)
      expect(inngest.send).not.toHaveBeenCalled()
    })

    // inventory_count_items.inventory_item_id carries a real FK, so an id the
    // crew staged before the PM deleted the item raised 23503 -> 500 -> the
    // same forever-retry. Dropping the stale id lets the rest of the count —
    // the part that is still meaningful — actually land.
    it('drops an item deleted since the count was staged, and records the rest', async () => {
      const DELETED = '99999999-8888-4777-8666-555555555555'
      const supabase = makeSupabase({
        properties:            [{ data: { id: PROP_ID }, error: null }],
        inventory_counts:      [{ data: null, error: null }, { data: { id: 'count_1' }, error: null }],
        inventory_count_items: [{ data: null, error: null }],
        inventory_items:       [{ data: [{ id: ITEM_ID }], error: null }, { data: null, error: null }],
      })
      mockAuthed(supabase)

      const res = await POST(
        postRequest({ propertyId: PROP_ID, counts: { [ITEM_ID]: 5, [DELETED]: 2 }, notes: '' }),
      )

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true, droppedItems: 1 })

      const itemsInsert = supabase.calls.find(
        (c) => c.table === 'inventory_count_items' && c.method === 'insert',
      )
      expect(itemsInsert!.args[0]).toEqual([
        { count_id: 'count_1', inventory_item_id: ITEM_ID, quantity_counted: 5 },
      ])
    })

    // The resolve is scoped to the property as well as the org, so a client
    // cannot attach another property's items to this property's count. The
    // quantity UPDATE was already org-scoped; the count_items INSERT was not
    // scoped at all.
    it('resolves counted ids against this property, not just the org', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: PROP_ID }, error: null }],
        inventory_counts:      [{ data: null, error: null }, { data: { id: 'count_1' }, error: null }],
        inventory_count_items: [{ data: null, error: null }],
        inventory_items:       [{ data: [{ id: ITEM_ID }], error: null }, { data: null, error: null }],
      })
      mockAuthed(supabase)

      await POST(postRequest({ propertyId: PROP_ID, counts: { [ITEM_ID]: 5 }, notes: '' }))

      const eqs = supabase.calls.filter((c) => c.table === 'inventory_items' && c.method === 'eq').map((c) => c.args)
      expect(eqs).toContainEqual(['org_id', ORG_ID])
      expect(eqs).toContainEqual(['property_id', PROP_ID])
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

  // The caller is the crew PWA's offline outbox, so every request here can
  // arrive twice and hours apart — well outside the five-minute double-tap
  // window. The countId is the primary key precisely so a replay collides;
  // treating that collision as a failure would 500 a count that HAD reached
  // the server, and the outbox would burn its retries and dead-letter it.
  describe('replay of an outbox submission (23505 on the count id)', () => {
    const COUNT_ID = '11111111-2222-4333-8444-555555555555'
    const PK_CONFLICT = { data: null, error: { code: '23505', message: 'duplicate key' } }

    it('reports success without re-applying when the first attempt fully landed', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: PROP_ID }, error: null }],
        inventory_counts:      [{ data: null, error: null }, PK_CONFLICT],
        inventory_count_items: [{ data: [{ id: 'existing_item' }], error: null }],
      })
      mockAuthed(supabase)

      const res = await POST(
        postRequest({ countId: COUNT_ID, propertyId: PROP_ID, counts: { [ITEM_ID]: 5 }, notes: '' }),
      )

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true, duplicate: true })
      expect(
        supabase.calls.some((c) => c.table === 'inventory_count_items' && c.method === 'insert'),
        'the physical count must not be recorded twice',
      ).toBe(false)
      // Same hole as the double-tap path above: not re-applying is correct,
      // not re-sending was not. handleInventoryCountSubmitted re-applies the
      // same quantities by upsert and checks for an existing purchase order
      // before creating one, so a second delivery is safe.
      expect(inngest.send).toHaveBeenCalledWith({
        id:   `inventory-count-submitted:${COUNT_ID}`,
        name: 'inventory/count-submitted',
        data: { count_id: COUNT_ID, property_id: PROP_ID, org_id: ORG_ID },
      })
    })

    it('resumes when the first attempt died between the count row and its items', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: PROP_ID }, error: null }],
        inventory_counts:      [{ data: null, error: null }, PK_CONFLICT],
        // First call is the replay probe (empty), second is the items insert.
        inventory_count_items: [{ data: [], error: null }, { data: null, error: null }],
        inventory_items:       [{ data: [{ id: ITEM_ID }], error: null }, { data: null, error: null }],
      })
      mockAuthed(supabase)

      const res = await POST(
        postRequest({ countId: COUNT_ID, propertyId: PROP_ID, counts: { [ITEM_ID]: 5 }, notes: '' }),
      )

      expect(res.status).toBe(200)
      const itemsInsert = supabase.calls.find(
        (c) => c.table === 'inventory_count_items' && c.method === 'insert',
      )
      expect(
        itemsInsert!.args[0],
        'the resumed apply must attach to the count row the first attempt created',
      ).toEqual([{ count_id: COUNT_ID, inventory_item_id: ITEM_ID, quantity_counted: 5 }])
      expect(inngest.send).toHaveBeenCalledWith({
        id:   `inventory-count-submitted:${COUNT_ID}`,
        name: 'inventory/count-submitted',
        data: { count_id: COUNT_ID, property_id: PROP_ID, org_id: ORG_ID },
      })
    })
  })

  // Each of these used to be indistinguishable from a normal outcome, because
  // the result was destructured for `data` with `error` dropped on the floor.
  describe('a failed query is not reported as a normal outcome', () => {
    it('answers 500, not 404, when the property lookup itself fails', async () => {
      const supabase = makeSupabase({
        properties: [{ data: null, error: { message: 'connection reset' } }],
      })
      mockAuthed(supabase)

      const res = await POST(postRequest({ propertyId: PROP_ID, counts: {}, notes: '' }))

      expect(
        res.status,
        '404 would tell the outbox the property is gone and dead-letter the count',
      ).toBe(500)
    })

    it('does not fall through to the insert when the dedup read fails', async () => {
      const supabase = makeSupabase({
        properties:       [{ data: { id: PROP_ID }, error: null }],
        inventory_counts: [{ data: null, error: { message: 'connection reset' } }],
      })
      mockAuthed(supabase)

      const res = await POST(postRequest({ propertyId: PROP_ID, counts: { [ITEM_ID]: 5 }, notes: '' }))

      expect(res.status).toBe(500)
      expect(
        supabase.calls.some((c) => c.table === 'inventory_counts' && c.method === 'insert'),
        'inserting anyway turns a transient read failure into a second physical count',
      ).toBe(false)
    })

    it('answers 500 when the count row lands but its items do not', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: PROP_ID }, error: null }],
        inventory_counts:      [{ data: null, error: null }, { data: { id: 'count_1' }, error: null }],
        inventory_count_items: [{ data: null, error: { message: 'insert failed' } }],
        inventory_items:       [{ data: [{ id: ITEM_ID }], error: null }],
      })
      mockAuthed(supabase)

      const res = await POST(postRequest({ propertyId: PROP_ID, counts: { [ITEM_ID]: 5 }, notes: '' }))

      expect(
        res.status,
        'a count with no items is not a submitted count — the device must retry',
      ).toBe(500)
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })
})
