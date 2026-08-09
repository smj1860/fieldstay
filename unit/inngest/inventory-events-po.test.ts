import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((_opts: unknown, _trigger: unknown, fn: unknown) => ({ fn })),
    send:           vi.fn(async () => undefined),
  },
}))
vi.mock('@/lib/resend/client', () => ({ resend: { emails: { send: vi.fn(async () => ({})) } }, FROM: 'x@y.z' }))
vi.mock('@/lib/inngest/helpers', () => ({ getPmEmails: vi.fn(async () => []) }))
vi.mock('@/lib/resend/emails/pm-alert', () => ({ renderPmAlert: vi.fn(() => '<p/>') }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/inngest/paginate', () => ({
  fetchAllRows: vi.fn(async () => []),
  SUPABASE_MAX_ROWS: 1000,
}))

import { handleInventoryCountSubmitted } from '@/lib/inngest/functions/inventory-events'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

/**
 * Replaces the mechanical coverage the inngest-insert-idempotency guardrail
 * lost when the purchase_order_items insert moved into a helper (that scan
 * only inspects `.insert(` inside a step.run body). See the removal note in
 * unit/guardrails/inngest-insert-idempotency.test.ts.
 *
 * The defect being pinned: the PO existence pre-check used to short-circuit on
 * the HEADER row alone. If the items insert failed after the header committed,
 * every retry found the header, returned alreadyExisted, and the PM opened a
 * restock order listing nothing — permanently, with nothing logged, because
 * both writes discarded their results.
 */
function makeSupabase(opts: {
  existingPo?:   { id: string; purchase_order_items: { id: string }[] } | null
  existingError?: { message: string } | null
  itemsInsertError?: { message: string } | null
  updateError?:  { message: string } | null
  /** Consumed in order by maybeSingle(), for the pre-check-then-race-re-read pair. */
  existingPoQueue?: ({ id: string; purchase_order_items: { id: string }[] } | null)[]
  /** Error the PO insert's .select().single() returns — 23505 models a lost race. */
  poInsertError?: { code?: string; message: string } | null
}) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  let maybeSingleCalls = 0

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'range', 'lt', 'gt']) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }
    chain.insert = (...a: unknown[]) => {
      record('insert', a)
      if (table === 'purchase_order_items') {
        return Promise.resolve({ data: null, error: opts.itemsInsertError ?? null })
      }
      return chain
    }
    chain.update = (...a: unknown[]) => {
      record('update', a)
      if (table === 'purchase_orders') {
        // The `.eq('id', …)` that follows resolves this thenable.
        chain.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: opts.updateError ?? null }).then(res)
      }
      return chain
    }
    chain.single = () =>
      Promise.resolve(
        opts.poInsertError
          ? { data: null, error: opts.poInsertError }
          : { data: { id: 'po_new' }, error: null },
      )
    chain.maybeSingle = () => {
      if (opts.existingPoQueue) {
        const next = opts.existingPoQueue[maybeSingleCalls++] ?? null
        return Promise.resolve({ data: next, error: null })
      }
      return Promise.resolve({ data: opts.existingPo ?? null, error: opts.existingError ?? null })
    }
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(res, rej)
    return chain
  })

  return { from, calls }
}

const event = {
  data: { count_id: 'cnt_1', property_id: 'prop_1', org_id: 'org_1' },
}

// The handler bails before the PO block unless there are below-par items, so
// these tests drive it through a step stub that supplies them.
function makeStep(belowPar: unknown[]) {
  return {
    // Keyed on step NAME rather than call order: the count-application step is
    // stubbed out (it is not what these tests pin), and every later step —
    // create-purchase-order included — runs its real body.
    run: vi.fn(async (name: string, cb: () => unknown) => {
      if (name === 'apply-count-and-check-par') return { belowParItems: belowPar }
      return cb()
    }),
  }
}

const belowParItem = {
  id: 'item_1', name: 'Paper towels', current_quantity: 1,
  par_level: 6, quantity_to_buy: 5, unit: 'roll',
}

describe('handleInventoryCountSubmitted — purchase order creation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does NOT short-circuit on a purchase order header that has zero line items', async () => {
    const supabase = makeSupabase({
      existingPo: { id: 'po_orphan', purchase_order_items: [] },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleInventoryCountSubmitted, {
      event, step: makeStep([belowParItem]),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }).catch(() => { /* later email steps are not under test */ })

    // The repair path must actually write the missing items.
    const itemsInsert = supabase.calls.find(
      (c) => c.table === 'purchase_order_items' && c.method === 'insert',
    )
    expect(itemsInsert).toBeDefined()
    const rows = itemsInsert!.args[0] as { purchase_order_id: string }[]
    expect(rows[0]!.purchase_order_id).toBe('po_orphan')
  })

  it('short-circuits on a purchase order that already has line items', async () => {
    const supabase = makeSupabase({
      existingPo: { id: 'po_done', purchase_order_items: [{ id: 'poi_1' }] },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleInventoryCountSubmitted, {
      event, step: makeStep([belowParItem]),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }).catch(() => { /* later steps not under test */ })

    expect(
      supabase.calls.some((c) => c.table === 'purchase_order_items' && c.method === 'insert'),
      'a complete PO must not have its items re-inserted on a retry',
    ).toBe(false)
  })

  it('throws when the line-item insert fails, instead of reporting success', async () => {
    const supabase = makeSupabase({
      existingPo: null,
      itemsInsertError: { message: 'deadlock detected' },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(handleInventoryCountSubmitted, {
        event, step: makeStep([belowParItem]),
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(/purchase_order_items insert failed/)
  })

  it('throws when the PO existence pre-check errors, rather than creating a second PO', async () => {
    const supabase = makeSupabase({
      existingPo: null,
      existingError: { message: 'connection reset' },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(handleInventoryCountSubmitted, {
        event, step: makeStep([belowParItem]),
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(/pre-check failed/)
  })
})

// ============================================================================
// The lost create race.
//
// po_source_count_unique is a partial unique index, so a concurrent duplicate
// (a double-tap, or a crew device replaying a mutation over a flaky link) is
// correctly rejected by Postgres with 23505 between the pre-check and the
// insert. That is the constraint working, not a fault — and it used to throw
// generically, burning an Inngest retry and logging an error for the one
// outcome that is entirely correct.
//
// It must NOT resolve by re-reading and returning the winner's header id: this
// file's first test exists because a header row alone is not enough. The race
// path has to land back in the same repair logic.
// ============================================================================
describe('handleInventoryCountSubmitted — losing the create race', () => {
  beforeEach(() => vi.clearAllMocks())

  it('treats a 23505 as already-handled when the winner wrote a COMPLETE purchase order', async () => {
    const supabase = makeSupabase({
      existingPoQueue: [
        null,                                                    // pre-check: nothing yet
        { id: 'po_winner', purchase_order_items: [{ id: 'x' }] },// race re-read: complete
      ],
      poInsertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleInventoryCountSubmitted, {
      event, step: makeStep([belowParItem]),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }).catch(() => { /* later email steps are not under test */ })

    // No duplicate items, and no throw that would burn a retry.
    expect(
      supabase.calls.some((c) => c.table === 'purchase_order_items' && c.method === 'insert'),
      'the winner already wrote the items — re-inserting them would duplicate the restock order',
    ).toBe(false)
  })

  it('REPAIRS the winner\'s purchase order when it lost the race to an empty header', async () => {
    // The trap in the obvious fix: "23505 → re-read → return alreadyExisted"
    // reintroduces exactly the permanent empty-restock-order bug the pre-check
    // above this describe block exists to prevent.
    const supabase = makeSupabase({
      existingPoQueue: [
        null,                                              // pre-check
        { id: 'po_winner', purchase_order_items: [] },     // race re-read: header only
      ],
      poInsertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleInventoryCountSubmitted, {
      event, step: makeStep([belowParItem]),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }).catch(() => { /* later steps not under test */ })

    const itemsInsert = supabase.calls.find(
      (c) => c.table === 'purchase_order_items' && c.method === 'insert',
    )
    expect(itemsInsert, 'the race loser must complete the winner\'s empty header').toBeDefined()
    const rows = itemsInsert!.args[0] as { purchase_order_id: string }[]
    expect(rows[0]!.purchase_order_id).toBe('po_winner')
  })

  it('still throws on any other insert error, so a real failure retries', async () => {
    const supabase = makeSupabase({
      existingPoQueue: [null],
      poInsertError: { code: '23503', message: 'foreign key violation' },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(invokeHandler(handleInventoryCountSubmitted, {
      event, step: makeStep([belowParItem]),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    })).rejects.toThrow(/foreign key violation/)
  })

  it('throws rather than reporting a purchase order that vanished after the 23505', async () => {
    // The winner rolled back between our insert and the re-read. Reporting a
    // PO id that does not exist is worse than retrying.
    const supabase = makeSupabase({
      existingPoQueue: [null, null],
      poInsertError: { code: '23505', message: 'duplicate key' },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(invokeHandler(handleInventoryCountSubmitted, {
      event, step: makeStep([belowParItem]),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    })).rejects.toThrow(/vanished after a 23505/)
  })
})
