import { vi } from 'vitest'

/**
 * A scripted stand-in for the Supabase query builder, shared by the GTM tests.
 *
 * Every call on the builder returns the builder, and awaiting it (or calling a
 * terminal like `.single()`) resolves to the next scripted result for that
 * table and operation. The operation is whichever of select/insert/update/delete
 * was called first, which is how the code under test distinguishes its queries.
 * Each call is recorded so a test can assert on the payload, not just the outcome.
 */
export interface Scripted { data?: unknown; error?: { code?: string; message: string } | null; count?: number | null }

type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete'
export interface RecordedCall { table: string; op: Op; payload?: unknown; filters: [string, unknown[]][] }

export function fakeSupabase(script: Record<string, Scripted[]>, rpc: Scripted[] = []) {
  const calls: RecordedCall[] = []
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]))
  const rpcQueue = [...rpc]
  const rpcCalls: { fn: string; args: unknown }[] = []

  function next(key: string): Scripted {
    const queue = queues.get(key)
    if (!queue || queue.length === 0) throw new Error(`fakeSupabase: nothing scripted for ${key}`)
    // The last scripted result repeats, so a loop that retries sees a stable answer.
    return queue.length > 1 ? queue.shift()! : queue[0]
  }

  const from = vi.fn((table: string) => {
    let call: RecordedCall | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const begin = (op: Op, payload?: unknown) => { call ??= { table, op, payload, filters: [] }; if (!calls.includes(call)) calls.push(call) }
    for (const op of ['select', 'insert', 'update', 'upsert', 'delete'] as const) {
      chain[op] = vi.fn((payload?: unknown) => { begin(op, op === 'select' ? undefined : payload); return chain })
    }
    for (const f of ['eq', 'neq', 'in', 'is', 'or', 'not', 'ilike', 'gt', 'gte', 'lt', 'lte', 'order', 'limit']) {
      chain[f] = vi.fn((...args: unknown[]) => { call?.filters.push([f, args]); return chain })
    }
    const resolve = () => Promise.resolve(next(`${table}:${call?.op ?? 'select'}`))
    chain.single = vi.fn(resolve)
    chain.maybeSingle = vi.fn(resolve)
    chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => resolve().then(ok, bad)
    return chain
  })

  const rpcFn = vi.fn((fn: string, args: unknown) => {
    rpcCalls.push({ fn, args })
    const result = rpcQueue.length > 1 ? rpcQueue.shift()! : rpcQueue[0]
    return Promise.resolve({ data: result?.data ?? null, error: result?.error ?? null })
  })

  return { client: { from, rpc: rpcFn } as never, calls, rpcCalls }
}
