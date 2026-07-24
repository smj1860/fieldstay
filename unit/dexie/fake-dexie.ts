// In-memory stand-in for the FieldStayDexie instance, covering exactly the
// surface the lib/dexie/sync/* functions touch (bulkPut/bulkDelete/toArray/
// where().anyOf().primaryKeys()/get/put). Lets the sync orchestration be
// unit-tested in the node environment without IndexedDB.

interface FakeRow { [key: string]: unknown }

export function fakeTable(pk = 'key') {
  const rows = new Map<unknown, FakeRow>()
  return {
    rows,
    async get(id: unknown) { return rows.get(id) },
    async put(row: FakeRow) { rows.set(row[pk], row) },
    async bulkPut(list: FakeRow[]) { for (const r of list) rows.set(r[pk], r) },
    async bulkDelete(ids: unknown[]) { for (const id of ids) rows.delete(id) },
    async toArray() { return [...rows.values()] },
    where(field: string) {
      return {
        anyOf: (values: unknown[]) => {
          const wanted = new Set(values)
          const matches = [...rows.values()].filter((r) => wanted.has(r[field]))
          return {
            primaryKeys: async () => matches.map((r) => r[pk]),
            toArray:     async () => matches,
          }
        },
      }
    },
  }
}

export function makeFakeDexieDb() {
  return {
    turnovers:                fakeTable('id'),
    checklist_instances:      fakeTable('id'),
    checklist_instance_items: fakeTable('id'),
    properties:               fakeTable('id'),
    inventory_items:          fakeTable('id'),
    crew_work_orders:         fakeTable('id'),
    sync_meta:                fakeTable('key'),
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
    for (const m of ['select', 'eq', 'in', 'gt', 'not', 'or']) {
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
