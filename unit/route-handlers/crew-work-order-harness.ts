import { vi } from 'vitest'

/**
 * The query/auth doubles shared by the two crew work-order route tests.
 *
 * Extracted because both routes now share one prologue
 * (lib/work-orders/crew-route-context.ts), so two copies of the harness that
 * exercises it could drift apart and quietly stop testing the same thing —
 * which is the failure mode that shared prologue exists to prevent.
 *
 * Ten other route-handler suites still carry their own copy of this shape.
 * That is a pre-existing pattern and deliberately not swept here; this module
 * covers the pair that share a code path.
 */

export type Resp = { data?: unknown; error?: unknown }

export interface FakeSupabase {
  from:  ReturnType<typeof vi.fn>
  calls: { table: string; method: string; args: unknown[] }[]
}

/**
 * `queue` is per table and consumed in order, so a route that reads a table
 * and then writes it gets two different results from one entry list.
 *
 * Note what this does NOT model: it is a recorder, not Postgres. It does not
 * enforce filters, constraints or `ON CONFLICT` arbiter rules — a passing
 * test here says the route issued the call it meant to, never that the
 * database would accept it.
 */
export function makeSupabase(queue: Record<string, Resp[]>): FakeSupabase {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'neq']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

/** The cookie-session client `requireCrewMember()` reads. */
export function makeAuthClient(userId: string | null, crewResult: Resp) {
  const getUser = vi.fn(async () => ({ data: { user: userId ? { id: userId } : null } }))
  const { from } = makeSupabase({ crew_members: [crewResult] })
  return { auth: { getUser }, from }
}

/**
 * work_orders.id is a `uuid`, so a malformed path param does not fail a type
 * check — it reaches Postgres and raises 22P02. These must be well-formed:
 * the IDOR guard is the org/assignment scoping, not the id FORMAT, and a
 * malformed id is rejected earlier, which would let an IDOR test pass without
 * ever exercising what it is named for.
 */
export const WO_ID         = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
export const OTHER_ORG_WO  = '2f1b8c44-1111-4222-8333-444455556666'
export const OTHER_CREW_WO = '3a2c9d55-2222-4333-8444-555566667777'
