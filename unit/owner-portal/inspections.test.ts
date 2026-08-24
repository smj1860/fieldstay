import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/supabase/unwrap', () => ({
  reportQueryError: (err: unknown) => !!err,
}))

import { loadOwnerInspections } from '@/lib/owner-portal/inspections'

// ============================================================================
// THE OWNER'S INSPECTION HISTORY.
//
// §2: posts the day it is completed, failures included, with the WO/PO shown
// alongside. §9: and that record's CURRENT status.
//
// Two things carry real weight here and the rest is presentation. The property
// scope is the tenant boundary for an UNAUTHENTICATED route — a token is the
// only credential, so a query that forgets to filter leaks a sibling owner's
// properties. And remediation has THREE shapes (§6), so a lookup that only
// knows one shows "no action taken" against a finding that is on somebody's
// list.
// ============================================================================

const ORG   = 'org-1'
const PROPS = ['prop-1']

interface Spec { data?: unknown; error?: { message: string } | null; count?: number }

function makeClient(tables: Record<string, Spec>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'not', 'or', 'order', 'limit', 'range']) {
        builder[m] = (...args: unknown[]) => { calls.push({ table, method: m, args }); return builder }
      }
      // Every `.range()` resolves to the same short page, which is what
      // terminates fetchAllRows' drain — a page shorter than the page size
      // means "no more rows". Fixtures here are 1–3 rows, so one page.
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({
        data:  tables[table]?.data ?? [],
        error: tables[table]?.error ?? null,
        count: tables[table]?.count ?? null,
      }).then(resolve)
      return builder
    },
  } as unknown as SupabaseClient

  return { client, calls }
}

const SNAPSHOT = { form_key: 'safety', form_version: 1, captured_at: '2026-03-01T10:00:00Z', sections: [] }

const inspection = (over: Record<string, unknown> = {}) => ({
  id: 'insp-1', property_id: 'prop-1', completed_at: '2026-03-05T14:00:00Z',
  form_version: 1, form_snapshot: SNAPSHOT, inspector_name: 'Dana Reyes',
  ...over,
})

const item = (over: Record<string, unknown> = {}) => ({
  id: 'item-1', inspection_id: 'insp-1', prompt_snapshot: 'Handrail secure',
  note: 'wobbles badly', result: 'fail',
  ...over,
})

describe('loadOwnerInspections — tenant scope', () => {
  it('scopes to the org AND the caller’s property ids', async () => {
    // The boundary. This route has no signed-in user; the token resolves to a
    // property set and every read has to be inside it. A missing filter here is
    // one owner seeing another owner's houses.
    const { client, calls } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [item()] },
    })
    await loadOwnerInspections(client, ORG, PROPS)

    const inspectionCalls = calls.filter((c) => c.table === 'inspections')
    expect(inspectionCalls.map((c) => c.args)).toContainEqual(['org_id', ORG])
    expect(inspectionCalls.map((c) => c.args)).toContainEqual(['property_id', PROPS])

    // And every follow-up read carries the org too.
    for (const table of ['inspection_items', 'work_orders', 'purchase_orders']) {
      expect(
        calls.filter((c) => c.table === table).map((c) => c.args),
        `${table} must be org-scoped`,
      ).toContainEqual(['org_id', ORG])
    }
  })

  it('reads nothing at all for an empty property scope', async () => {
    // A token that authorizes no properties must produce no query, not a query
    // with an empty `in()` — which PostgREST treats as matching nothing only if
    // it parses at all.
    const { client, calls } = makeClient({})
    expect(await loadOwnerInspections(client, ORG, []))
      .toEqual({ inspections: [], totalCompleted: 0 })
    expect(calls).toHaveLength(0)
  })

  it('shows only COMPLETED walks', async () => {
    // Half a form is worse than nothing, and an in-progress walk is not a
    // record.
    const { client, calls } = makeClient({ inspections: { data: [] } })
    await loadOwnerInspections(client, ORG, PROPS)
    expect(calls.filter((c) => c.method === 'not').map((c) => c.args))
      .toContainEqual(['completed_at', 'is', null])
  })

  it('bounds every read', async () => {
    const { client, calls } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [item()] },
    })
    await loadOwnerInspections(client, ORG, PROPS)
    for (const table of ['inspections', 'work_orders', 'purchase_orders']) {
      expect(
        calls.some((c) => c.table === table && c.method === 'limit'),
        `${table} read must be bounded — max_rows truncates silently`,
      ).toBe(true)
    }
  })

  it('PAGINATES the item read rather than bounding it with .limit()', async () => {
    // The one read whose row count is a MULTIPLE of the inspection count. The
    // seeded forms are 53–60 items apiece, so 24 walks is ~1,500 rows — past
    // PostgREST's 1,000-row cap, which truncates with a 200 and no signal.
    //
    // A `.limit(4800)` does not raise that cap. It looks like a bound, passes
    // any assertion that only asks "is there a limit?", and the visible symptom
    // would be the OLDEST walks rendering as "0 checks passed, no findings" —
    // an inspection that reads as clean because its answers were dropped. So
    // this asserts .range() specifically, and asserts .limit() is ABSENT: a
    // later "let's just bound it" edit has to fail here.
    const { client, calls } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [item()] },
    })
    await loadOwnerInspections(client, ORG, PROPS)

    const itemCalls = calls.filter((c) => c.table === 'inspection_items')
    expect(itemCalls.some((c) => c.method === 'range')).toBe(true)
    expect(itemCalls.some((c) => c.method === 'limit')).toBe(false)
    // A stable sort is what makes .range() page boundaries mean anything.
    expect(itemCalls.map((c) => c.args)).toContainEqual(['id', { ascending: true }])
  })

  it('reports the TOTAL completed count, so a capped page can say it is capped', async () => {
    // Without the total there is no way to tell "this is the whole record" from
    // "this is the first page of it", and the page would present the second as
    // the first — a history that stops partway through 2024 reads as the PM
    // having given up, not as a page limit.
    const { client } = makeClient({
      inspections: { data: [inspection()], count: 106 },
      inspection_items: { data: [] },
    })
    const history = await loadOwnerInspections(client, ORG, PROPS)
    expect(history.inspections).toHaveLength(1)
    expect(history.totalCompleted).toBe(106)
  })

  it('claims no hidden history when the driver returns no count', async () => {
    // Degrading to "nothing was hidden" is the safe direction: the alternative
    // is a "showing 1 of 0" banner on a portal we cannot fix from the owner's
    // side.
    const { client } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [] },
    })
    expect((await loadOwnerInspections(client, ORG, PROPS)).totalCompleted).toBe(1)
  })
})

describe('loadOwnerInspections — what the owner sees', () => {
  it('counts PASSES, not "everything that did not fail"', async () => {
    // An N/A is neither a pass nor a failure, and counting it as a pass
    // overstates the walk to the person the record is meant to reassure.
    const { client } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [
        item({ id: 'a', result: 'pass' }),
        item({ id: 'b', result: 'pass' }),
        item({ id: 'c', result: 'na' }),
        item({ id: 'd', result: 'fail' }),
      ] },
    })

    const [row] = (await loadOwnerInspections(client, ORG, PROPS)).inspections
    expect(row!.passCount).toBe(2)
    expect(row!.findings).toHaveLength(1)
  })

  it('takes the form label from the SNAPSHOT, with its version', async () => {
    // §11.6: a three-year history spanning two form versions must say which was
    // used, or it reads as inconsistent inspecting rather than an improving
    // form. Reading the label off the live form would undo that on a re-seed.
    const { client } = makeClient({
      inspections: { data: [inspection({ form_version: 3 })] },
      inspection_items: { data: [] },
    })
    const [row] = (await loadOwnerInspections(client, ORG, PROPS)).inspections
    expect(row).toMatchObject({ formLabel: 'Safety & Risk Mitigation', formVersion: 3 })
  })

  it('survives an unreadable snapshot rather than dropping the inspection', async () => {
    const { client } = makeClient({
      inspections: { data: [inspection({ form_snapshot: null })] },
      inspection_items: { data: [] },
    })
    const [row] = (await loadOwnerInspections(client, ORG, PROPS)).inspections
    expect(row!.formLabel).toBe('Inspection')
  })
})

describe('loadOwnerInspections — remediation has three shapes', () => {
  it('matches a per-finding work order to its own item', async () => {
    const { client } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [item({ id: 'item-1' })] },
      work_orders: { data: [{
        wo_number: 'WO-1042', status: 'in_progress',
        source_inspection_item_id: 'item-1', source_inspection_id: null,
      }] },
    })

    const [row] = (await loadOwnerInspections(client, ORG, PROPS)).inspections
    expect(row!.findings[0]!.remediation).toEqual({
      kind: 'work_order', reference: 'WO-1042', status: 'in_progress',
    })
  })

  it('falls back to the CLEANING roll-up, which is keyed on the inspection', async () => {
    // §5: cleaning findings roll up into ONE work order for the whole walk,
    // keyed on source_inspection_id rather than on any one item. A lookup that
    // only knew the per-item key would tell the owner nothing was done.
    const { client } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [item({ id: 'item-1' })] },
      work_orders: { data: [{
        wo_number: 'WO-2000', status: 'pending',
        source_inspection_item_id: null, source_inspection_id: 'insp-1',
      }] },
    })

    const [row] = (await loadOwnerInspections(client, ORG, PROPS)).inspections
    expect(row!.findings[0]!.remediation).toEqual({
      kind: 'work_order', reference: 'WO-2000', status: 'pending',
    })
  })

  it('falls back to the purchase order, also keyed on the inspection', async () => {
    const { client } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [item({ id: 'item-1' })] },
      purchase_orders: { data: [{ id: 'po-1', status: 'ordered', source_inspection_id: 'insp-1' }] },
    })

    const [row] = (await loadOwnerInspections(client, ORG, PROPS)).inspections
    expect(row!.findings[0]!.remediation).toMatchObject({ kind: 'purchase_order', status: 'ordered' })
  })

  it('prefers the item’s OWN work order over either roll-up', async () => {
    // A finding can be both — a stained rug whose fitting also needs repairing
    // is needs_cleaning AND remediation = 'work_order'. The specific answer is
    // the right one; showing the cleaning job against a repair finding would
    // misdescribe it.
    const { client } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [item({ id: 'item-1' })] },
      work_orders: { data: [
        { wo_number: 'WO-CLEAN', status: 'pending', source_inspection_item_id: null, source_inspection_id: 'insp-1' },
        { wo_number: 'WO-OWN',   status: 'assigned', source_inspection_item_id: 'item-1', source_inspection_id: null },
      ] },
      purchase_orders: { data: [{ id: 'po-1', status: 'draft', source_inspection_id: 'insp-1' }] },
    })

    const [row] = (await loadOwnerInspections(client, ORG, PROPS)).inspections
    expect(row!.findings[0]!.remediation).toMatchObject({ reference: 'WO-OWN' })
  })

  it('a work-order roll-up wins over a purchase order on the same inspection', async () => {
    // Two conflicting statuses against one line teaches an owner nothing.
    const { client } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [item({ id: 'item-1' })] },
      work_orders: { data: [{
        wo_number: 'WO-CLEAN', status: 'pending',
        source_inspection_item_id: null, source_inspection_id: 'insp-1',
      }] },
      purchase_orders: { data: [{ id: 'po-1', status: 'draft', source_inspection_id: 'insp-1' }] },
    })

    const [row] = (await loadOwnerInspections(client, ORG, PROPS)).inspections
    expect(row!.findings[0]!.remediation).toMatchObject({ kind: 'work_order' })
  })

  it('does not query per-finding work orders when a walk had no failures', async () => {
    // `in.()` with an empty list is a PostgREST SYNTAX ERROR, not a
    // match-nothing — the read fails outright and takes the roll-up lookups
    // with it if they share a query.
    const { client, calls } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [item({ result: 'pass' })] },
    })
    await loadOwnerInspections(client, ORG, PROPS)

    const woIns = calls.filter((c) => c.table === 'work_orders' && c.method === 'in').map((c) => c.args)
    expect(woIns.some(([col]) => col === 'source_inspection_item_id')).toBe(false)
    // The roll-up lookup still runs — a walk with no failures can still have a
    // cleaning job, since needs_cleaning is independent of the result.
    expect(woIns.some(([col]) => col === 'source_inspection_id')).toBe(true)
  })

  it('says so plainly when a failure produced nothing', async () => {
    // §5's `remediation = 'notify'` — a lapsed permit is a notification, not a
    // dispatch. The owner should see the finding and that no job came of it,
    // rather than a blank.
    const { client } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [item()] },
    })
    const [row] = (await loadOwnerInspections(client, ORG, PROPS)).inspections
    expect(row!.findings[0]!.remediation).toEqual({ kind: 'none' })
  })
})

describe('loadOwnerInspections — failure modes', () => {
  it('returns an empty history rather than throwing when the read fails', async () => {
    // A portal that 500s because one section could not load is worse for the
    // owner than a portal missing that section. Reported, not silent.
    const { client } = makeClient({ inspections: { error: { message: 'connection reset' } } })
    expect(await loadOwnerInspections(client, ORG, PROPS))
      .toEqual({ inspections: [], totalCompleted: 0 })
  })

  it('still shows the walks when the ITEM read throws mid-drain', async () => {
    // fetchAllRows THROWS on a page error rather than returning a partial set —
    // deliberately, since a silently short drain is the bug it exists to
    // prevent. That has to be caught here, or one failed page 500s the owner's
    // whole portal instead of one section of it.
    const { client } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { error: { message: 'connection reset' } },
    })

    const history = await loadOwnerInspections(client, ORG, PROPS)
    expect(history.inspections).toHaveLength(1)
    expect(history.inspections[0]!.passCount).toBe(0)
    expect(history.inspections[0]!.findings).toEqual([])
  })

  it('still shows the walk when the REMEDIATION lookup fails', async () => {
    // Degrades to "noted" rather than losing the finding: the inspection
    // happening at all is the record, and the job status is the annotation.
    const { client } = makeClient({
      inspections: { data: [inspection()] },
      inspection_items: { data: [item()] },
      work_orders: { error: { message: 'timeout' } },
      purchase_orders: { error: { message: 'timeout' } },
    })

    const [row] = (await loadOwnerInspections(client, ORG, PROPS)).inspections
    expect(row!.findings).toHaveLength(1)
    expect(row!.findings[0]!.remediation).toEqual({ kind: 'none' })
  })
})
