import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/inngest/helpers', () => ({ createPmNotification: vi.fn() }))

import { inspectionCompleted } from '@/lib/inngest/functions/inspection-completed'
import { createPmNotification } from '@/lib/inngest/helpers'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// ============================================================================
// REMEDIATION — what a failed inspection turns into.
//
// §6: a work order per failure, ONE purchase order per inspection, a
// notification for the items that dispatch nothing. Two properties matter more
// than the happy path.
//
// IT RUNS ON COMPLETION, NOT ON THE TICK. An inspector ticks No on a loose
// handrail, tightens it while standing there, and changes the answer to Yes —
// fire-on-tick has already left a work order for someone to close as
// not-a-thing. That is Tuesday across sixty items and a 24-hour draft window,
// so this reads only SUBMITTED answers and refuses an inspection that is
// somehow still open.
//
// AND IT IS SAFE TO RE-RUN. Inngest retries a failed step, so a pass that
// created three of five work orders must be able to finish rather than double.
// ============================================================================

const ORG   = 'org-1'
const INSP  = 'insp-1'
const PROP  = 'prop-1'

interface Def {
  id: string
  remediation: string
  concern_key?: string | null
  wo_category?: string | null
  wo_priority?: string | null
  po_default_qty?: number | null
}

function snapshot(defs: Def[]) {
  return {
    form_key: 'safety', form_version: 1, captured_at: '2026-08-23T10:00:00Z',
    sections: [{
      id: 'sec-1', key: 'fire', name: 'Fire', sort_order: 0, shown_when_asset: null,
      items: defs.map((d) => ({ concern_key: null, ...d })),
    }],
  }
}

/**
 * A Supabase double that records writes.
 *
 * Each table gets its own queued read result; everything else resolves empty.
 * Enough to assert WHAT is written and HOW MANY times, which is the whole
 * question here.
 */
interface ClientOpts {
  inspection?: Record<string, unknown> | null
  failedItems?: Record<string, unknown>[]
  existingWorkOrders?: { source_inspection_item_id: string }[]
  /** Open prior work orders, in the shape the `inspection_items!inner` embed returns. */
  priorWorkOrders?: Record<string, unknown>[]
  priorError?: { message: string }
  /** What `inspection_form_items` resolves those priors' form items to. */
  concernKeys?: { id: string; concern_key: string | null }[]
  poError?: { code?: string; message: string } | null
  woError?: { code?: string; message: string } | null
  /** Which named predecessors are still in an open status. */
  stillOpenWorkOrderIds?: string[]
  openPredecessorError?: { message: string }
  /** Recurrence notes already on those work orders, for the replay case. */
  existingUpdates?: { work_order_id: string; notes: string }[]
  /** Occupying bookings in the next occurrence's month — the vacancy nudge. */
  bookings?: { checkin_date: string; checkout_date: string }[]
  /** Completed turnovers at this property, newest first — the last-cleaner walk. */
  lastTurnovers?: { id: string; completed_at: string }[]
  turnoverAssignments?: { turnover_id: string; crew_member_id: string | null }[]
  crewMembers?: { id: string; name: string; is_active: boolean }[]
  turnoverError?: { message: string }
  /** Distinct from woError: only the cleaning roll-up's insert fails. */
  cleaningWoError?: { code?: string; message: string } | null
  /** The §7 schedule this walk satisfies, if any. */
  sourceSchedule?: { id: string; property_id?: string; frequency: string | null; next_due_date: string | null } | null
  /** Simulates the optimistic lock losing — another pass advanced it first. */
  scheduleAdvanceLostRace?: boolean
}

type QueryResult = { data: unknown; error: unknown }

const ok  = (data: unknown): QueryResult => ({ data, error: null })
const bad = (error: unknown): QueryResult => ({ data: null, error })

/**
 * `work_orders` is read THREE times with three different column lists — the
 * still-open check, the prior-annotation lookup, and the already-created
 * pre-check. Dispatching on call ORDER broke the moment a same-issue item made
 * the first read conditional, so this keys on what each read actually asks for.
 */
function workOrdersRead(selected: string, opts: ClientOpts): QueryResult {
  if (selected.includes('inspection_items')) {
    return opts.priorError ? bad(opts.priorError) : ok(opts.priorWorkOrders ?? [])
  }
  if (selected.includes('source_inspection_item_id')) return ok(opts.existingWorkOrders ?? [])

  // The still-open check on a named predecessor.
  return opts.openPredecessorError
    ? bad(opts.openPredecessorError)
    : ok((opts.stillOpenWorkOrderIds ?? []).map((id) => ({ id })))
}

/** What an awaited (non-single) query on `table` resolves to. */
function listRead(table: string, selected: string, opts: ClientOpts): QueryResult {
  switch (table) {
    case 'inspection_items':      return ok(opts.failedItems ?? [])
    case 'work_orders':           return workOrdersRead(selected, opts)
    case 'work_order_updates':    return ok(opts.existingUpdates ?? [])
    case 'bookings':              return ok(opts.bookings ?? [])
    case 'turnover_assignments':  return ok(opts.turnoverAssignments ?? [])
    case 'crew_members':          return ok(opts.crewMembers ?? [])
    case 'inspection_form_items': return ok(opts.concernKeys ?? [])
    case 'turnovers':
      return opts.turnoverError ? bad(opts.turnoverError) : ok(opts.lastTurnovers ?? [])
    // The UPDATE's .select('id') — empty when the lock lost.
    case 'maintenance_schedules':
      return ok(opts.scheduleAdvanceLostRace ? [] : [{ id: 'sched-1' }])
    default: return ok([])
  }
}

function makeClient(opts: ClientOpts) {
  const writes: { table: string; rows: unknown[] }[] = []
  // Ordering is a contract with Postgres that an in-memory double cannot
  // simulate — it can only be observed. Without this, a test asserting "the
  // oldest predecessor wins" passes on whatever order the fixture array
  // happened to be written in, including with the ORDER BY deleted.
  const orderBys: { table: string; column: string; ascending?: boolean }[] = []

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      // `work_orders` is now read THREE times with three different column
      // lists — the still-open check, the prior-annotation lookup, and the
      // already-created pre-check. Dispatching on call ORDER broke the moment
      // a same-issue item made the first read conditional, so the double keys
      // on what each read actually asks for.
      let selected = ''
      const chain = () => builder
      for (const m of ['eq', 'in', 'limit', 'not', 'lte', 'gte']) builder[m] = chain
      builder.select = (cols?: unknown) => {
        if (typeof cols === 'string') selected = cols
        return builder
      }
      builder.order = (column: string, o?: { ascending?: boolean }) => {
        orderBys.push({ table, column, ascending: o?.ascending })
        return builder
      }

      builder.maybeSingle = () => {
        if (table === 'maintenance_schedules') {
          return Promise.resolve({ data: opts.sourceSchedule ?? null, error: null })
        }
        return Promise.resolve({
          data: opts.inspection === undefined ? {} : opts.inspection, error: null,
        })
      }
      builder.single = () => Promise.resolve(
        opts.poError ? { data: null, error: opts.poError } : { data: { id: 'po-1' }, error: null },
      )
      builder.update = (patch: unknown) => {
        writes.push({ table, rows: [patch] })
        return builder
      }
      builder.insert = (rows: unknown) => {
        const arr = Array.isArray(rows) ? rows : [rows]
        writes.push({ table, rows: arr })
        // The cleaning roll-up and the per-finding inserts both write
        // work_orders. They are told apart by source_inspection_id, which ONLY
        // the roll-up sets — the same discriminator the partial unique index
        // uses — so a test can fail one without failing the other.
        const isCleaning = table === 'work_orders'
          && !!(arr[0] as Record<string, unknown> | undefined)?.source_inspection_id
        let err: { code?: string; message: string } | null | undefined = null
        if (table === 'work_orders') err = isCleaning ? opts.cleaningWoError : opts.woError
        const result = { data: table === 'purchase_orders' ? { id: 'po-1' } : null, error: err ?? null }
        return {
          select: () => ({ single: () => Promise.resolve(
            opts.poError ? { data: null, error: opts.poError } : { data: { id: 'po-1' }, error: null },
          ) }),
          then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r),
        }
      }

      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(listRead(table, selected, opts)).then(resolve)

      return builder
    },
  }

  return { client, writes, orderBys }
}

function ctx() {
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
  const step = { run: vi.fn(async (_n: string, cb: () => unknown) => await cb()) }
  return { event: { data: { org_id: ORG, inspection_id: INSP } }, step, logger }
}

const failedItem = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'item-1', form_item_id: 'def-1', prompt_snapshot: 'Handrail secure',
  note: 'wobbles badly', photo_path: null, asset_id: null, actions: ['repair'],
  needs_cleaning: false,
  repeat_answer: null, repeat_of_work_order_id: null,
  ...over,
})

const inspectionRow = (defs: Def[], over: Record<string, unknown> = {}) => ({
  id: INSP, org_id: ORG, property_id: PROP,
  form_snapshot: snapshot(defs), completed_at: '2026-08-23T12:00:00Z',
  source_schedule_id: null,
  ...over,
})

beforeEach(() => { vi.clearAllMocks() })

describe('inspectionCompleted — what a failure becomes', () => {
  it('a work_order failure creates one work order carrying the finding', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order', wo_category: 'structural', wo_priority: 'high' }]),
      failedItems: [failedItem()],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())

    expect(result).toMatchObject({ workOrders: 1, purchaseOrders: 0 })
    const wo = writes.find((w) => w.table === 'work_orders')!.rows[0] as Record<string, unknown>
    expect(wo).toMatchObject({
      org_id: ORG, property_id: PROP, source: 'inspection',
      source_inspection_item_id: 'item-1',
      // §5: the description IS the title, which is why a fail requires one.
      title: 'wobbles badly',
      category: 'structural', priority: 'high', status: 'pending',
    })
    expect(String(wo.description)).toContain('Handrail secure')
    expect(String(wo.description)).toContain('repair')
  })

  it('falls back to the prompt when a fail somehow has no description', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [failedItem({ note: null })],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)
    await invokeHandler(inspectionCompleted, ctx())

    const wo = writes.find((w) => w.table === 'work_orders')!.rows[0] as Record<string, unknown>
    expect(wo.title).toBe('Handrail secure')
  })

  it('ONE purchase order for the whole inspection, not one per item', async () => {
    // §6: "a PM who needs three bulbs, a fire extinguisher and an HVAC filter
    // wants one order, not three."
    const { client, writes } = makeClient({
      inspection: inspectionRow([
        { id: 'def-1', remediation: 'purchase_order', po_default_qty: 2 },
        { id: 'def-2', remediation: 'purchase_order' },
        { id: 'def-3', remediation: 'purchase_order' },
      ]),
      failedItems: [
        failedItem({ id: 'i1', form_item_id: 'def-1', note: 'bulbs' }),
        failedItem({ id: 'i2', form_item_id: 'def-2', note: 'extinguisher' }),
        failedItem({ id: 'i3', form_item_id: 'def-3', note: 'filter' }),
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())

    expect(result).toMatchObject({ purchaseOrders: 1 })
    expect(writes.filter((w) => w.table === 'purchase_orders')).toHaveLength(1)
    const lines = writes.find((w) => w.table === 'purchase_order_items')!.rows
    expect(lines).toHaveLength(3)
    expect((lines[0] as Record<string, unknown>).quantity_to_buy).toBe(2)
    // Default when the item names no quantity — one of the thing.
    expect((lines[1] as Record<string, unknown>).quantity_to_buy).toBe(1)
  })

  it('a notify failure raises ONE notification, deduped per inspection', async () => {
    // §5 added `notify` because "a lapsed permit or unpaid HOA dues is a
    // notification, not a dispatch." The bell is not a work queue, so three
    // such failures are one notification.
    const { client, writes } = makeClient({
      inspection: inspectionRow([
        { id: 'def-1', remediation: 'notify' }, { id: 'def-2', remediation: 'notify' },
      ]),
      failedItems: [
        failedItem({ id: 'i1', form_item_id: 'def-1', prompt_snapshot: 'HOA dues current' }),
        failedItem({ id: 'i2', form_item_id: 'def-2', prompt_snapshot: 'Permit displayed' }),
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())

    expect(result).toMatchObject({ notifications: 2, workOrders: 0, purchaseOrders: 0 })
    expect(createPmNotification).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createPmNotification).mock.calls[0]![1]).toMatchObject({
      orgId: ORG, severity: 'amber', dedupeKey: `inspection-attention:${INSP}`,
    })
    expect(writes.filter((w) => w.table === 'work_orders')).toHaveLength(0)
  })

  it('a remediation of none produces nothing at all', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'none' }]),
      failedItems: [failedItem()],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ workOrders: 0, purchaseOrders: 0, notifications: 0 })
    expect(writes).toEqual([])
  })
})

describe('inspectionCompleted — retry safety', () => {
  it('skips items an earlier pass already created a work order for', async () => {
    // The retry case. Inngest re-runs a failed step, so a pass that created
    // three of five must finish rather than double.
    const { client, writes } = makeClient({
      inspection: inspectionRow([
        { id: 'def-1', remediation: 'work_order' }, { id: 'def-2', remediation: 'work_order' },
      ]),
      failedItems: [
        failedItem({ id: 'i1', form_item_id: 'def-1' }),
        failedItem({ id: 'i2', form_item_id: 'def-2' }),
      ],
      existingWorkOrders: [{ source_inspection_item_id: 'i1' }],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())

    expect(result).toMatchObject({ workOrders: 1 })
    const rows = writes.find((w) => w.table === 'work_orders')!.rows
    expect(rows).toHaveLength(1)
    expect((rows[0] as Record<string, unknown>).source_inspection_item_id).toBe('i2')
  })

  it('a PO that already exists is left alone rather than double-lined', async () => {
    // 23505 on uq_purchase_orders_source_inspection. Its line items may or may
    // not have landed; appending a second copy of every line is the one
    // outcome a PM cannot see and cannot undo.
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'purchase_order' }]),
      failedItems: [failedItem()],
      poError: { code: '23505', message: 'duplicate key' },
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())

    expect(result).toMatchObject({ purchaseOrders: 0 })
    expect(writes.filter((w) => w.table === 'purchase_order_items')).toHaveLength(0)
  })

  it('a real PO error THROWS, so the step retries', async () => {
    const { client } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'purchase_order' }]),
      failedItems: [failedItem()],
      poError: { code: '42501', message: 'permission denied' },
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await expect(invokeHandler(inspectionCompleted, ctx())).rejects.toThrow(/permission denied/)
  })

  it('a work-order insert error THROWS rather than reporting success', async () => {
    const { client } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [failedItem()],
      woError: { code: '23505', message: 'duplicate key' },
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    // Postgres rejects the WHOLE statement on a conflict, so nothing was
    // written — reporting success would lose every work order in the batch.
    await expect(invokeHandler(inspectionCompleted, ctx())).rejects.toThrow(/duplicate key/)
  })
})

describe('inspectionCompleted — the repeat visit', () => {
  // §6 wants the INSPECTOR asked whether a recurrence is the same fault. Until
  // that prompt exists this only NOTES the relationship, which can never
  // wrongly suppress a fault or wrongly merge two. But a note that never
  // appears is worse than no note: it reads as "nothing was open" on a
  // maintenance board that has the March one sitting on it.

  const priorRow = (over: Record<string, unknown> = {}) => ({
    wo_number: 'WO-0007', created_at: '2026-03-04T09:00:00Z', title: 'Handrail wobbles',
    inspection_items: { form_item_id: 'def-1', inspection_id: 'insp-MARCH' },
    ...over,
  })

  const descriptionOf = (writes: { table: string; rows: unknown[] }[]) =>
    String((writes.find((w) => w.table === 'work_orders')!.rows[0] as Record<string, unknown>).description)

  it('notes an open predecessor on the same form item', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [failedItem()],
      priorWorkOrders: [priorRow()],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)
    await invokeHandler(inspectionCompleted, ctx())

    const d = descriptionOf(writes)
    expect(d).toContain('already open since 2026-03-04')
    expect(d).toContain('WO-0007')
  })

  it('matches through the CONCERN KEY, not just the form item id', async () => {
    // The defect this test exists for. 68 of the 173 seeded items carry a
    // concern key — `handrail_secure` among them — and the lookup key is
    // `concern_key ?? form_item_id`. Keying the prior map by form_item_id meant
    // every one of those 68 silently found nothing, including the worked
    // example in the function's own header.
    const { client, writes } = makeClient({
      // Today's failure is asked by a DIFFERENT form, so a different item id.
      inspection: inspectionRow([
        { id: 'def-seasonal', remediation: 'work_order', concern_key: 'handrail_secure' },
      ]),
      failedItems: [failedItem({ form_item_id: 'def-seasonal' })],
      // March's work order came from the safety form's item.
      priorWorkOrders: [priorRow({ inspection_items: { form_item_id: 'def-safety', inspection_id: 'insp-MARCH' } })],
      concernKeys: [{ id: 'def-safety', concern_key: 'handrail_secure' }],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)
    await invokeHandler(inspectionCompleted, ctx())

    expect(descriptionOf(writes)).toContain('already open since')
  })

  it('accepts the embed as an array as well as an object', async () => {
    // Whether PostgREST returns a to-one embed as an object or a single-element
    // array is not decided in this file, and guessing wrong costs no error at
    // all — every row is skipped and the note quietly never appears.
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [failedItem()],
      priorWorkOrders: [priorRow({
        inspection_items: [{ form_item_id: 'def-1', inspection_id: 'insp-MARCH' }],
      })],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)
    await invokeHandler(inspectionCompleted, ctx())

    expect(descriptionOf(writes)).toContain('already open since')
  })

  it('never annotates a work order as a repeat of its OWN inspection', async () => {
    // A retry re-reads the work orders the first pass created. Without the
    // guard, the second pass would tell the PM that the job it is about to
    // create is a repeat of itself.
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [failedItem()],
      priorWorkOrders: [priorRow({
        inspection_items: { form_item_id: 'def-1', inspection_id: INSP },
      })],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)
    await invokeHandler(inspectionCompleted, ctx())

    expect(descriptionOf(writes)).not.toContain('already open')
  })

  it('keeps the OLDEST predecessor when several are open', async () => {
    // "Already open since <date>" has to name the date the fault was first
    // raised, not whichever row came back first.
    const { client, writes, orderBys } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [failedItem()],
      priorWorkOrders: [
        priorRow({ wo_number: 'WO-0007', created_at: '2026-03-04T09:00:00Z' }),
        priorRow({ wo_number: 'WO-0044', created_at: '2026-06-01T09:00:00Z' }),
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)
    await invokeHandler(inspectionCompleted, ctx())

    // Half of this is in the query, not in the code under test: the function
    // keeps the FIRST row per concern, so "first" only means "oldest" because
    // the read asked Postgres for it in that order.
    expect(orderBys).toContainEqual({ table: 'work_orders', column: 'created_at', ascending: true })
    expect(descriptionOf(writes)).toContain('WO-0007')
    expect(descriptionOf(writes)).not.toContain('WO-0044')
  })

  it('a failed lookup costs the footnote, never the work order', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [failedItem()],
      priorError: { message: 'relation does not exist' },
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ workOrders: 1 })
    expect(descriptionOf(writes)).not.toContain('already open')
  })
})

describe('inspectionCompleted — what it refuses to act on', () => {
  it('refuses an inspection that is not completed', async () => {
    // §6's whole point. If the event outran its transaction, retrying is right;
    // producing work orders from a draft is not.
    const { client } = makeClient({
      inspection: { ...inspectionRow([]), completed_at: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await expect(invokeHandler(inspectionCompleted, ctx())).rejects.toThrow(/not completed/)
  })

  it('an unreadable snapshot throws rather than silently remediating nothing', async () => {
    const { client } = makeClient({
      inspection: { ...inspectionRow([]), form_snapshot: { nonsense: true } },
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await expect(invokeHandler(inspectionCompleted, ctx())).rejects.toThrow(/form_snapshot/)
  })

  it('a missing inspection is reported, not retried forever', async () => {
    const { client } = makeClient({ inspection: null })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    expect(await invokeHandler(inspectionCompleted, ctx())).toEqual({ skipped: 'not_found' })
  })

  it('an answer whose form item is absent from its own snapshot is skipped and logged', async () => {
    // Should be impossible; it would mean the snapshot and the answers disagree
    // about what was asked. There is no routing to act on, so skipping is
    // right — but silently would hide a genuine inconsistency.
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [failedItem({ form_item_id: 'def-MISSING' })],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const c = ctx()
    const result = await invokeHandler(inspectionCompleted, c)

    expect(result).toMatchObject({ workOrders: 0 })
    expect(writes).toEqual([])
    expect(c.logger.warn).toHaveBeenCalled()
  })
})

// ============================================================================
// §6's ANSWER, HONOURED.
//
// The prompt exists so the INSPECTOR decides whether a recurrence is the same
// fault, because no key can. "Refrigeration" fails in March for a water filter
// (Replace, a PO) and in June for a compressor (Service, a work order): same
// form_item_id, two unrelated problems, and any key-based rule files the
// failing compressor as a note on the water-filter task — quietly.
//
// What matters most here is not that "same" attaches. It is that every way the
// attach can go wrong FALLS BACK TO CREATING, because a suppressed finding is
// invisible and a duplicate one is merely annoying.
// ============================================================================
const OPEN_WO = 'wo-march'

describe('inspectionCompleted — the repeat answer', () => {
  const sameIssue = (over: Record<string, unknown> = {}) => failedItem({
    repeat_answer: 'same', repeat_of_work_order_id: OPEN_WO, ...over,
  })

  it('attaches to the open job instead of opening a second one', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [sameIssue()],
      stillOpenWorkOrderIds: [OPEN_WO],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())

    expect(result).toMatchObject({ workOrders: 0, attachedToOpen: 1 })
    expect(writes.filter((w) => w.table === 'work_orders')).toHaveLength(0)
    const note = writes.find((w) => w.table === 'work_order_updates')!.rows[0] as Record<string, unknown>
    expect(note).toMatchObject({ work_order_id: OPEN_WO, org_id: ORG })
    expect(String(note.notes)).toContain('Failed again')
    // The job's STATE is unchanged — only its history gains a line.
    expect(note.status_from).toBeNull()
    expect(note.status_to).toBeNull()
  })

  it('"new issue" creates a work order, exactly as before', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [failedItem({ repeat_answer: 'new', repeat_of_work_order_id: OPEN_WO })],
      stillOpenWorkOrderIds: [OPEN_WO],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ workOrders: 1, attachedToOpen: 0 })
    expect(writes.filter((w) => w.table === 'work_order_updates')).toHaveLength(0)
  })

  it('creates when the predecessor has since been COMPLETED', async () => {
    // The inspector answered against what their device had cached, possibly
    // days old. A fault recurring AFTER a repair is a new job, not a note on a
    // finished one.
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [sameIssue()],
      stillOpenWorkOrderIds: [],   // no longer open
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ workOrders: 1, attachedToOpen: 0 })
    expect(writes.filter((w) => w.table === 'work_order_updates')).toHaveLength(0)
  })

  it('creates when the predecessor was DELETED out from under the answer', async () => {
    // repeat_of_work_order_id is ON DELETE SET NULL, so 'same' can outlive the
    // job it named. This is the case the dropped database CHECK would have
    // forbidden outright — and suppressing the finding here would lose it.
    const { client } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [failedItem({ repeat_answer: 'same', repeat_of_work_order_id: null })],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ workOrders: 1, attachedToOpen: 0 })
  })

  it('does not post the same recurrence note twice on a replay', async () => {
    // work_order_updates has no dedupe column to collide against, so the note
    // text is deterministic and a replay recognises its own earlier write.
    const first = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [sameIssue()],
      stillOpenWorkOrderIds: [OPEN_WO],
    })
    vi.mocked(createServiceClient).mockReturnValue(first.client as never)
    await invokeHandler(inspectionCompleted, ctx())
    const posted = first.writes.find((w) => w.table === 'work_order_updates')!.rows[0] as { notes: string }

    const replay = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [sameIssue()],
      stillOpenWorkOrderIds: [OPEN_WO],
      existingUpdates: [{ work_order_id: OPEN_WO, notes: posted.notes }],
    })
    vi.mocked(createServiceClient).mockReturnValue(replay.client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    // Still reported as attached: the counter describes the INSPECTION'S
    // outcome, not this run's writes, so an idempotent replay tells the same
    // story as the first pass. What must be zero is the writes.
    expect(result).toMatchObject({ attachedToOpen: 1, workOrders: 0 })
    expect(replay.writes.filter((w) => w.table === 'work_order_updates')).toHaveLength(0)
    // And critically: it must not decide the finding is unattached and open a
    // work order for it on the second pass.
    expect(replay.writes.filter((w) => w.table === 'work_orders')).toHaveLength(0)
  })

  it('mixes both answers in one inspection without either losing a finding', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([
        { id: 'def-1', remediation: 'work_order' }, { id: 'def-2', remediation: 'work_order' },
      ]),
      failedItems: [
        sameIssue({ id: 'i1', form_item_id: 'def-1' }),
        failedItem({ id: 'i2', form_item_id: 'def-2' }),
      ],
      stillOpenWorkOrderIds: [OPEN_WO],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ workOrders: 1, attachedToOpen: 1 })
    const created = writes.find((w) => w.table === 'work_orders')!.rows
    expect((created[0] as Record<string, unknown>).source_inspection_item_id).toBe('i2')
  })

  it('a failed predecessor lookup THROWS rather than silently creating a duplicate', async () => {
    // The opposite bias from the annotation lookup, and deliberately so: that
    // one only decorates a description, this one decides whether a second job
    // is opened. Guessing here produces the duplicate board §6 exists to stop.
    const { client } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [sameIssue()],
      openPredecessorError: { message: 'connection reset' },
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await expect(invokeHandler(inspectionCompleted, ctx())).rejects.toThrow(/connection reset/)
  })
})

// ============================================================================
// §7: A SCHEDULED WALK ROLLS ITS SCHEDULE FORWARD.
//
// An inspection schedule NOTIFIES when it comes due and creates nothing — an
// inspections row minted by the cron would claim the walk started at 08:00
// UTC, and the report presents that duration as evidence. So nothing has acted
// on the schedule at due time, and the advance has to happen on COMPLETION.
//
// Which makes this step load-bearing rather than cosmetic: the due
// notification is deduped per (schedule, due date), so with next_due_date never
// moving it fires once and the schedule goes silent forever.
// ============================================================================
describe('inspectionCompleted — the source schedule', () => {
  const scheduled = (over: Record<string, unknown> = {}) => makeClient({
    inspection: inspectionRow([], { source_schedule_id: 'sched-1' }),
    failedItems: [],
    sourceSchedule: { id: 'sched-1', property_id: PROP, frequency: 'quarterly', next_due_date: '2026-08-01' },
    ...over,
  })

  it('advances a quarterly schedule by three months from its DUE date', async () => {
    // Anchored on next_due_date, not on today: a walk done three days late
    // still lands the next one on the month the recurrence has always used.
    const { client, writes } = scheduled()
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())

    expect(result).toMatchObject({ scheduleAdvanced: true })
    const patch = writes.find((w) => w.table === 'maintenance_schedules')!.rows[0] as Record<string, unknown>
    expect(patch.next_due_date).toBe('2026-11-01')
    expect(patch.last_completed_date).toBeTruthy()
  })

  it('moves the next occurrence onto a vacant day INSIDE the due month', async () => {
    // An inspection is a walk-through — somebody is inside for an hour with a
    // camera. Landing an occurrence mid-stay produces a notification the PM can
    // only reschedule, and the recurrence puts it right back next quarter.
    const { client, writes } = scheduled({
      // Booked over the 1st; free from the 9th.
      bookings: [{ checkin_date: '2026-10-28', checkout_date: '2026-11-09' }],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await invokeHandler(inspectionCompleted, ctx())
    const patch = writes.find((w) => w.table === 'maintenance_schedules')!.rows[0] as Record<string, unknown>
    expect(patch.next_due_date).toBe('2026-11-09')
  })

  it('keeps the date rather than leaving the month when November is booked solid', async () => {
    // The month IS the recurrence anchor — calcNextDueDate steps whole months
    // from the due date, and there is no anchor column. Sliding to December
    // would re-anchor this series to December and the next one to March.
    const { client, writes } = scheduled({
      bookings: [{ checkin_date: '2026-10-20', checkout_date: '2026-12-05' }],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await invokeHandler(inspectionCompleted, ctx())
    const patch = writes.find((w) => w.table === 'maintenance_schedules')!.rows[0] as Record<string, unknown>
    expect(patch.next_due_date).toBe('2026-11-01')
  })

  it('advances even when the walk found nothing wrong', async () => {
    // The most common outcome by far, and the one a naive implementation
    // skips by hanging the advance off the remediation path.
    const { client, writes } = scheduled()
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ workOrders: 0, scheduleAdvanced: true })
    expect(writes.some((w) => w.table === 'maintenance_schedules')).toBe(true)
  })

  it('does nothing for an ad-hoc walk', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([]), failedItems: [],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ scheduleAdvanced: false })
    expect(writes.some((w) => w.table === 'maintenance_schedules')).toBe(false)
  })

  it('reports NOT advanced when the optimistic lock loses', async () => {
    // Two completions of one occurrence must not double-step the calendar.
    const { client } = scheduled({ scheduleAdvanceLostRace: true })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    expect(await invokeHandler(inspectionCompleted, ctx())).toMatchObject({ scheduleAdvanced: false })
  })

  it('a vanished schedule costs a notification, never the remediation', async () => {
    // Deliberately the opposite bias to the remediation steps: throwing here
    // would retry the whole function and re-run remediation for work orders
    // that already exist.
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }], { source_schedule_id: 'sched-gone' }),
      failedItems: [failedItem()],
      sourceSchedule: null,
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ scheduleAdvanced: false, workOrders: 1 })
    expect(writes.some((w) => w.table === 'work_orders')).toBe(true)
  })
})

// ============================================================================
// THE CLEANING ROLL-UP
//
// §5 keeps cleaning OUT of the remediation enum on purpose, and the reason is
// dispatch economics: a stained rug, a dirty oven and cobwebs found on one walk
// are ONE visit. So `needs_cleaning` is an independent boolean and the roll-up
// happens here — one work order for the whole inspection, keyed on
// source_inspection_id rather than on any one finding's id.
//
// The suggested cleaner is not a scorer's output. It is whoever last cleaned
// this property: if an inspection found it still needs cleaning, the job was
// left incomplete, and the person to send back is the one who was already there.
// ============================================================================

const cleaningInsert = (writes: { table: string; rows: unknown[] }[]) =>
  writes
    .filter((w) => w.table === 'work_orders')
    .map((w) => w.rows[0] as Record<string, unknown>)
    .find((r) => !!r.source_inspection_id)

describe('inspectionCompleted — the cleaning roll-up', () => {
  const cleaningItem = (over: Record<string, unknown> = {}) =>
    failedItem({ needs_cleaning: true, ...over })

  it('rolls MANY flagged findings into ONE cleaning work order', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([
        { id: 'def-1', remediation: 'none' },
        { id: 'def-2', remediation: 'none' },
        { id: 'def-3', remediation: 'none' },
      ]),
      failedItems: [
        cleaningItem({ id: 'i-1', form_item_id: 'def-1', prompt_snapshot: 'Rug clean',  note: 'stained' }),
        cleaningItem({ id: 'i-2', form_item_id: 'def-2', prompt_snapshot: 'Oven clean', note: null }),
        cleaningItem({ id: 'i-3', form_item_id: 'def-3', prompt_snapshot: 'No cobwebs', note: null }),
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())

    expect(result).toMatchObject({ cleaningWorkOrders: 1 })
    const woWrites = writes.filter((w) => w.table === 'work_orders')
    expect(woWrites).toHaveLength(1)

    const wo = cleaningInsert(writes)!
    expect(wo).toMatchObject({
      org_id: ORG, property_id: PROP,
      category: 'cleaning', status: 'pending', source: 'inspection',
      source_inspection_id: INSP,
      title: 'Cleaning — 3 items from an inspection',
    })
    // Every finding is named, so the cleaner knows what the walk actually found.
    expect(String(wo.description)).toContain('Rug clean — stained')
    expect(String(wo.description)).toContain('Oven clean')
    expect(String(wo.description)).toContain('No cobwebs')
  })

  it('does NOT squat on source_inspection_item_id — a repair on the SAME finding still dispatches', async () => {
    // The trap this column exists to avoid. A stained rug whose fitting also
    // needs repairing is needs_cleaning AND remediation = 'work_order'.
    // createWorkOrders pre-checks source_inspection_item_id to decide what is
    // already handled, so a cleaning roll-up wearing that item's id would make
    // the item look done and SUPPRESS its own repair.
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order', wo_category: 'general' }]),
      failedItems: [cleaningItem({ id: 'item-1' })],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ workOrders: 1, cleaningWorkOrders: 1 })

    const rows = writes.filter((w) => w.table === 'work_orders').flatMap((w) => w.rows) as Record<string, unknown>[]
    const repair   = rows.find((r) => r.source_inspection_item_id === 'item-1')!
    const cleaning = rows.find((r) => !!r.source_inspection_id)!
    expect(repair.category).toBe('general')
    // Each key belongs to exactly one of them. That is the whole invariant.
    expect(repair.source_inspection_id).toBeUndefined()
    expect(cleaning.source_inspection_item_id).toBeUndefined()
  })

  it('nothing flagged means no cleaning work order at all', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'work_order' }]),
      failedItems: [failedItem()],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    expect(await invokeHandler(inspectionCompleted, ctx())).toMatchObject({ cleaningWorkOrders: 0 })
    expect(cleaningInsert(writes)).toBeUndefined()
  })

  it('suggests the crew who last cleaned the property, and does not assign them', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'none' }]),
      failedItems: [cleaningItem()],
      lastTurnovers: [{ id: 't-2', completed_at: '2026-08-20T18:00:00Z' }],
      turnoverAssignments: [{ turnover_id: 't-2', crew_member_id: 'crew-a' }],
      crewMembers: [{ id: 'crew-a', name: 'Maya Torres', is_active: true }],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ cleaningWorkOrders: 1, cleaningCrewSuggested: 1 })

    const wo = cleaningInsert(writes)!
    expect(wo.suggested_crew_member_ids).toEqual(['crew-a'])
    expect(wo.suggestion_status).toBe('pending')
    expect(String(wo.suggestion_reasoning)).toContain('Maya Torres')
    expect(String(wo.suggestion_reasoning)).toContain('2026-08-20')
    // SUGGESTED, not assigned — a PM accepts it on the board.
    expect(wo.assigned_crew_member_id).toBeUndefined()
    // And never a vendor suggestion: the DB forbids both
    // (work_orders_one_suggestion_kind), so a write carrying both would 23514.
    expect(wo.suggested_vendor_ids).toBeUndefined()
  })

  it('walks BACK past a completed turnover that had nobody assigned', async () => {
    // The most recent completion may have no assignment at all — completed by a
    // PM, imported from a channel, crew removed afterwards. Stopping at the
    // first row would produce no suggestion with a good answer one row down.
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'none' }]),
      failedItems: [cleaningItem()],
      lastTurnovers: [
        { id: 't-3', completed_at: '2026-08-22T18:00:00Z' },
        { id: 't-2', completed_at: '2026-08-15T18:00:00Z' },
      ],
      turnoverAssignments: [{ turnover_id: 't-2', crew_member_id: 'crew-b' }],
      crewMembers: [{ id: 'crew-b', name: 'Dee Okafor', is_active: true }],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)
    await invokeHandler(inspectionCompleted, ctx())

    const wo = cleaningInsert(writes)!
    expect(wo.suggested_crew_member_ids).toEqual(['crew-b'])
    // The date names the turnover they actually cleaned, not the empty newer one.
    expect(String(wo.suggestion_reasoning)).toContain('2026-08-15')
  })

  it('an inactive last cleaner suggests NOBODY rather than the wrong person', async () => {
    // Their turnover is where the walk stops. Falling through to the turnover
    // before it would name someone who did not leave the job incomplete.
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'none' }]),
      failedItems: [cleaningItem()],
      lastTurnovers: [
        { id: 't-3', completed_at: '2026-08-22T18:00:00Z' },
        { id: 't-2', completed_at: '2026-08-15T18:00:00Z' },
      ],
      turnoverAssignments: [
        { turnover_id: 't-3', crew_member_id: 'crew-gone' },
        { turnover_id: 't-2', crew_member_id: 'crew-b' },
      ],
      crewMembers: [{ id: 'crew-gone', name: 'Departed', is_active: false }],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ cleaningWorkOrders: 1, cleaningCrewSuggested: 0 })

    const wo = cleaningInsert(writes)!
    expect(wo.suggested_crew_member_ids).toBeNull()
    expect(wo.suggestion_status).toBeNull()
  })

  it('a property with no completed turnovers still gets the work order', async () => {
    // The job is the deliverable; the suggestion is a convenience. A new
    // property has nobody to name and must not lose the cleaning because of it.
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'none' }]),
      failedItems: [cleaningItem()],
      lastTurnovers: [],
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ cleaningWorkOrders: 1, cleaningCrewSuggested: 0 })
    expect(cleaningInsert(writes)!.suggestion_status).toBeNull()
  })

  it('a failed turnover lookup costs the suggestion, never the work order', async () => {
    const { client, writes } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'none' }]),
      failedItems: [cleaningItem()],
      turnoverError: { message: 'connection reset' },
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await invokeHandler(inspectionCompleted, ctx())
    expect(result).toMatchObject({ cleaningWorkOrders: 1, cleaningCrewSuggested: 0 })
    expect(cleaningInsert(writes)).toBeDefined()
  })

  it('a replay collides on the unique index instead of booking a second visit', async () => {
    // 23505 = uq_work_orders_source_inspection. An earlier pass already created
    // it; the findings have not changed, so leave it alone.
    const { client } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'none' }]),
      failedItems: [cleaningItem()],
      cleaningWoError: { code: '23505', message: 'duplicate key' },
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    expect(await invokeHandler(inspectionCompleted, ctx())).toMatchObject({ cleaningWorkOrders: 0 })
  })

  it('THROWS on any other insert failure — a silently lost cleaning job is the bug', async () => {
    const { client } = makeClient({
      inspection: inspectionRow([{ id: 'def-1', remediation: 'none' }]),
      failedItems: [cleaningItem()],
      cleaningWoError: { code: '23502', message: 'null value in column' },
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await expect(invokeHandler(inspectionCompleted, ctx())).rejects.toThrow(/cleaning work order insert failed/)
  })
})
