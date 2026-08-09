// In-memory stand-in for the FieldStayDexie instance, covering exactly the
// surface the lib/dexie/sync/* functions touch (bulkPut/bulkDelete/toArray/
// where().anyOf().primaryKeys()/where().equals().filter().count()/sortBy/get/put,
// plus db.transaction()). Lets the sync orchestration be unit-tested in the
// node environment without IndexedDB.

interface FakeRow { [key: string]: unknown }

/**
 * Minimal stand-in for a Dexie Collection: enough of the chain for the
 * filter/count/toArray shapes the outbox and prune paths use.
 */
function fakeCollection(matches: FakeRow[], pk: string) {
  const collection = {
    primaryKeys: async () => matches.map((r) => r[pk]),
    toArray:     async () => matches,
    count:       async () => matches.length,
    // Dexie sorts the MATCHED rows in memory — the index supplies membership,
    // not order. Modelled the same way so the outbox drain's insertion-order
    // guarantee is actually exercised.
    sortBy:      async (field: string) =>
      [...matches].sort((a, b) => ((a[field] as number) < (b[field] as number) ? -1 : 1)),
    filter: (predicate: (row: never) => boolean) =>
      fakeCollection(matches.filter((r) => predicate(r as never)), pk),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modify: async (apply: (row: any) => void) => { for (const r of matches) apply(r) },
  }
  return collection
}

/**
 * Compound-index key equality, mirroring IndexedDB's array-key semantics —
 * `where('[table+targetId]').equals(['turnovers', 'x'])`.
 *
 * Strict `===`, deliberately: IndexedDB leaves a record OUT of an index when
 * the indexed property is undefined, so a row seeded without `failed` is
 * invisible to `where('failed').equals(0)` in the real thing too. A fake that
 * quietly matched it would hide the exact hazard the outbox's indexed drain
 * depends on avoiding.
 */
function matchesKey(row: FakeRow, fields: string[], value: unknown): boolean {
  if (fields.length === 1) return row[fields[0]!] === value
  const parts = Array.isArray(value) ? value : [value]
  return fields.every((field, i) => row[field] === parts[i])
}

/** '[table+targetId]' → ['table', 'targetId']; 'failed' → ['failed']. */
function indexFields(index: string): string[] {
  return index.startsWith('[') ? index.slice(1, -1).split('+') : [index]
}

export function fakeTable(pk = 'key') {
  const rows = new Map<unknown, FakeRow>()
  // Auto-increment counter for add() on '++id'-style outbox tables.
  let nextAutoId = 0
  return {
    rows,
    async get(id: unknown) { return rows.get(id) },
    async put(row: FakeRow) { rows.set(row[pk], row) },
    async add(row: FakeRow) {
      const id = row[pk] ?? ++nextAutoId
      rows.set(id, { ...row, [pk]: id })
      return id
    },
    async update(id: unknown, changes: FakeRow) {
      const existing = rows.get(id)
      if (!existing) return 0
      rows.set(id, { ...existing, ...changes })
      return 1
    },
    async delete(id: unknown) { rows.delete(id) },
    async bulkPut(list: FakeRow[]) { for (const r of list) rows.set(r[pk], r) },
    async bulkDelete(ids: unknown[]) { for (const id of ids) rows.delete(id) },
    async toArray() { return [...rows.values()] },
    toCollection() { return fakeCollection([...rows.values()], pk) },
    filter(predicate: (row: never) => boolean) {
      return fakeCollection([...rows.values()].filter((r) => predicate(r as never)), pk)
    },
    orderBy(field: string) {
      return {
        toArray: async () =>
          [...rows.values()].sort((a, b) => ((a[field] as number) < (b[field] as number) ? -1 : 1)),
      }
    },
    where(index: string) {
      const fields = indexFields(index)
      return {
        anyOf: (values: unknown[]) => {
          const wanted = new Set(values)
          return fakeCollection([...rows.values()].filter((r) => wanted.has(r[fields[0]!])), pk)
        },
        equals: (value: unknown) =>
          fakeCollection([...rows.values()].filter((r) => matchesKey(r, fields, value)), pk),
      }
    },
  }
}

export function makeFakeDexieDb() {
  return {
    // Dexie's transaction() runs its callback immediately and resolves with the
    // result. The in-memory double is inherently atomic (nothing can interleave
    // between two synchronous Map writes), so it only needs to invoke the body
    // — what the real thing buys us is durability across an app kill, which is
    // not something a fake can model. The tests that matter here assert that
    // BOTH writes are inside one transaction() call, not that a rollback works.
    transaction: <T>(_mode: string, ...args: unknown[]): Promise<T> => {
      const body = args[args.length - 1] as () => Promise<T>
      return Promise.resolve(body())
    },
    turnovers:                fakeTable('id'),
    checklist_instances:      fakeTable('id'),
    checklist_instance_items: fakeTable('id'),
    properties:               fakeTable('id'),
    inventory_items:          fakeTable('id'),
    crew_work_orders:         fakeTable('id'),
    property_assets:          fakeTable('id'),
    pending_photo_uploads:    fakeTable('id'),
    sync_meta:                fakeTable('key'),
    mutations:                fakeTable('id'),
  }
}

export type FakeDexieDb = ReturnType<typeof makeFakeDexieDb>

// Queue-based chainable supabase mock — same convention as the Inngest
// tests' makeSupabase: each `.from(table)` call consumes the next queued
// response for that table, in call order; every chained filter method is
// recorded for assertions on query shape (e.g. "the delta pull used .gt").
export function makeFakeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    // 'limit'  — id-scoped chunk reads now assert their own ceiling
    //            (.limit(IN_CHUNK_SIZE)); the limit never binds, it documents
    //            that N ids in can only yield N rows out.
    // 'order'/'range' — the one-to-many checklist reads drain each chunk via
    //            fetchInChunksPaginated, because chunking turnover_ids does
    //            NOT bound the item rows those ids fan out to.
    for (const m of ['select', 'eq', 'in', 'gt', 'not', 'or', 'update', 'limit', 'order', 'range']) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }
    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: [], error: null })
    }
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  }

  return { from, calls }
}
