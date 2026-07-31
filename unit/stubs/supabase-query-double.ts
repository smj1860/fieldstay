/**
 * ONE shared Supabase query-builder double for the Inngest suites.
 *
 * Every `unit/inngest/*.test.ts` used to hand-roll its own `makeSupabase()`
 * with whatever subset of the PostgREST chain that particular function
 * happened to call. When the cron functions were moved onto
 * `lib/inngest/paginate.ts` (`.order(...).range(from, to)`), thirteen of those
 * divergent doubles broke at once with `order is not a function` /
 * `range is not a function` — the divergence *was* the bug. This module is the
 * single place the chain is modelled, so a new builder method has to be added
 * exactly once.
 *
 * Two things it does that a naive `chain.x = () => chain` mock does not:
 *
 *   1. **The chain composes and is awaitable at any point.** Every builder
 *      method returns the same thenable chain, so
 *      `.select().eq().neq().in().gt().lt().is().not().order().range().limit()`
 *      resolves, and so does `.single()` / `.maybeSingle()` at any depth.
 *
 *   2. **Pagination is real.** `.range(from, to)` returns the corresponding
 *      slice of the seeded dataset, so `fetchAllRows()` genuinely drains page
 *      after page and a >1000-row fixture is genuinely walked to the end
 *      instead of being silently answered in full on page 0 (which would make
 *      the truncation bug the helper exists to prevent invisible to tests).
 *
 * Response specs, per table:
 *   - fixed: `{ data, error }` — every query against the table resolves it.
 *     `.range()` slices `data` when it is an array, so seeding 2,500 rows here
 *     makes the double serve three real pages.
 *   - queue: `[{ data, error }, ...]` — consumed in resolution order, one
 *     entry per *logical* query. A paginated query consumes its entry on the
 *     first page (`from === 0`) and every subsequent page slices that same
 *     entry, so paging never eats a later query's queued response.
 */

import { vi, type Mock } from 'vitest'

export interface QueryResponse {
  data?:  unknown
  error?: unknown
  count?: number | null
}

/** A table is seeded either with one fixed response or a queue of them. */
export type TableSpec = QueryResponse | QueryResponse[]

export interface RecordedCall {
  table:  string
  method: string
  args:   unknown[]
}

/**
 * `ReturnType<typeof vi.fn>` widens to `Mock<Procedure | Constructable>`, which
 * TypeScript refuses to call (TS2348 — "did you mean to include 'new'?").
 * Naming the call signature explicitly keeps `spy(...)` callable while still
 * exposing the full `Mock` assertion surface (`toHaveBeenCalledWith`, …).
 */
type Spy = Mock<(...args: unknown[]) => unknown>

/** `Mock` is invariant in its call signature, so these keep their own shapes. */
type FromSpy = Mock<(table: string) => Record<string, unknown>>
type RpcSpy  = Mock<(fn: string, args?: unknown) => Promise<unknown>>
type AuthSpy = Mock<() => Promise<unknown>>

export interface SupabaseDouble {
  from: FromSpy
  rpc:  RpcSpy
  auth: { admin: { getUserById: AuthSpy } }
  /** Every builder method call, in order, tagged with its table. */
  calls: RecordedCall[]
  /** Convenience spies, called as (table, ...args) — used by ical-sync et al. */
  selectSpy: Spy
  eqSpy:     Spy
  inSpy:     Spy
  insertSpy: Spy
  updateSpy: Spy
  upsertSpy: Spy
  deleteSpy: Spy
  rangeSpy:  Spy
  orderSpy:  Spy
}

export interface SupabaseDoubleOptions {
  /** Return value (or implementation) for `supabase.rpc(...)`. */
  rpc?: QueryResponse | ((fn: string, args?: unknown) => unknown)
  /** Return value for `supabase.auth.admin.getUserById(...)`. */
  authUser?: unknown
}

/**
 * Builder methods that just narrow/shape a query. All of them are chainable
 * and recorded; none of them change what the double resolves to (the fixture
 * is already the intended result set) — except `.range()`, which really
 * slices, because pagination correctness is a thing these tests must catch.
 */
const CHAINABLE = [
  'select', 'eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'is', 'not', 'or',
  'like', 'ilike', 'filter', 'match', 'contains', 'overlaps', 'order',
  'limit', 'insert', 'update', 'upsert', 'delete', 'returns', 'abortSignal',
  'csv', 'explain', 'onConflict',
] as const

function isQueue(spec: TableSpec | undefined): spec is QueryResponse[] {
  return Array.isArray(spec)
}

function sliceResponse(response: QueryResponse, from: number, to: number): QueryResponse {
  if (!Array.isArray(response.data)) return response
  return { ...response, data: response.data.slice(from, to + 1) }
}

/**
 * @param tables  per-table fixed response or queue of responses
 * @param options rpc / auth stubs for the functions that reach past `.from()`
 */
export function createSupabaseDouble(
  tables: Record<string, TableSpec> = {},
  options: SupabaseDoubleOptions = {},
): SupabaseDouble {
  const calls: RecordedCall[] = []
  const queueIndex:  Record<string, number> = {}
  /** Last response consumed by a paginated query, per table — pages 2..n slice this. */
  const pageSource: Record<string, QueryResponse> = {}

  const spies = {
    selectSpy: vi.fn(),
    eqSpy:     vi.fn(),
    inSpy:     vi.fn(),
    insertSpy: vi.fn(),
    updateSpy: vi.fn(),
    upsertSpy: vi.fn(),
    deleteSpy: vi.fn(),
    rangeSpy:  vi.fn(),
    orderSpy:  vi.fn(),
  }
  const spyForMethod: Record<string, Spy> = {
    select: spies.selectSpy,
    eq:     spies.eqSpy,
    in:     spies.inSpy,
    insert: spies.insertSpy,
    update: spies.updateSpy,
    upsert: spies.upsertSpy,
    delete: spies.deleteSpy,
    range:  spies.rangeSpy,
    order:  spies.orderSpy,
  }

  function consumeNext(table: string): QueryResponse {
    const spec = tables[table]
    if (spec === undefined) return { data: null, error: null }
    if (!isQueue(spec)) return spec
    const idx = queueIndex[table] ?? 0
    queueIndex[table] = idx + 1
    return spec[idx] ?? { data: null, error: null }
  }

  const from = vi.fn((table: string) => {
    let range: { from: number; to: number } | null = null

    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      spyForMethod[method]?.(table, ...args)
    }

    const resolve = (): QueryResponse => {
      if (!range) return consumeNext(table)
      // Page 1 of a paginated query consumes a queued entry; later pages
      // slice that same entry so paging doesn't eat the next query's fixture.
      if (range.from === 0) pageSource[table] = consumeNext(table)
      const source = pageSource[table] ?? { data: null, error: null }
      return sliceResponse(source, range.from, range.to)
    }

    const chain: Record<string, unknown> = {}

    for (const method of CHAINABLE) {
      chain[method] = (...args: unknown[]) => {
        record(method, args)
        return chain
      }
    }

    chain.range = (fromIndex: number, toIndex: number) => {
      record('range', [fromIndex, toIndex])
      range = { from: fromIndex, to: toIndex }
      return chain
    }

    chain.single      = () => Promise.resolve(consumeNext(table))
    chain.maybeSingle = () => Promise.resolve(consumeNext(table))

    chain.then = (
      onFulfilled?: (value: QueryResponse) => unknown,
      onRejected?:  (reason: unknown) => unknown,
    ) => Promise.resolve(resolve()).then(onFulfilled, onRejected)

    return chain
  })

  const rpcImpl = options.rpc
  const rpc = vi.fn(async (fn: string, args?: unknown) => {
    if (typeof rpcImpl === 'function') return rpcImpl(fn, args)
    return rpcImpl ?? { data: null, error: null }
  })

  const getUserById = vi.fn(async () =>
    options.authUser ?? { data: { user: { email: 'pm@test.com', user_metadata: {} } }, error: null },
  )

  return {
    from,
    rpc,
    auth: { admin: { getUserById } },
    calls,
    ...spies,
  }
}
