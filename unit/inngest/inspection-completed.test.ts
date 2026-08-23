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
function makeClient(opts: {
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
}) {
  const writes: { table: string; rows: unknown[] }[] = []
  // Ordering is a contract with Postgres that an in-memory double cannot
  // simulate — it can only be observed. Without this, a test asserting "the
  // oldest predecessor wins" passes on whatever order the fixture array
  // happened to be written in, including with the ORDER BY deleted.
  const orderBys: { table: string; column: string; ascending?: boolean }[] = []
  // createWorkOrders reads work_orders twice: the prior-annotation lookup
  // first, then the already-created pre-check.
  let workOrderReads = 0

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      for (const m of ['select', 'eq', 'in', 'limit']) builder[m] = chain
      builder.order = (column: string, o?: { ascending?: boolean }) => {
        orderBys.push({ table, column, ascending: o?.ascending })
        return builder
      }

      builder.maybeSingle = () => Promise.resolve({
        data: opts.inspection === undefined ? {} : opts.inspection, error: null,
      })
      builder.single = () => Promise.resolve(
        opts.poError ? { data: null, error: opts.poError } : { data: { id: 'po-1' }, error: null },
      )
      builder.insert = (rows: unknown) => {
        const arr = Array.isArray(rows) ? rows : [rows]
        writes.push({ table, rows: arr })
        const err = table === 'work_orders' ? opts.woError : null
        const result = { data: table === 'purchase_orders' ? { id: 'po-1' } : null, error: err ?? null }
        return {
          select: () => ({ single: () => Promise.resolve(
            opts.poError ? { data: null, error: opts.poError } : { data: { id: 'po-1' }, error: null },
          ) }),
          then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r),
        }
      }

      builder.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'inspection_items') {
          return Promise.resolve({ data: opts.failedItems ?? [], error: null }).then(resolve)
        }
        if (table === 'work_orders') {
          workOrderReads += 1
          if (workOrderReads === 1) {
            return Promise.resolve(opts.priorError
              ? { data: null, error: opts.priorError }
              : { data: opts.priorWorkOrders ?? [], error: null }).then(resolve)
          }
          return Promise.resolve({
            data: opts.existingWorkOrders ?? [], error: null,
          }).then(resolve)
        }
        if (table === 'inspection_form_items') {
          return Promise.resolve({ data: opts.concernKeys ?? [], error: null }).then(resolve)
        }
        return Promise.resolve({ data: [], error: null }).then(resolve)
      }
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
  ...over,
})

const inspectionRow = (defs: Def[]) => ({
  id: INSP, org_id: ORG, property_id: PROP,
  form_snapshot: snapshot(defs), completed_at: '2026-08-23T12:00:00Z',
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
