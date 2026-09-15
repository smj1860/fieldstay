import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import {
  accountDeletion,
  ORG_PURGE_TABLES,
  ORG_TABLES_WITHOUT_CASCADE,
  ORG_TABLES_BLOCKING_CASCADE,
} from '@/lib/inngest/functions/account-deletion'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'
import { CRITICAL_FUNCTION_IDS } from '@/lib/inngest/functions/on-failure'
import { invokeHandler } from './test-helpers'

// ============================================================================
// The DESTRUCTIVE half of account deletion, moved off the request thread on
// 2026-08-09.
//
// Every guarantee asserted here used to be asserted against the route, and the
// reason for each one is unchanged — only the place it has to hold. They are
// re-pinned here rather than deleted because the failure they prevent is the
// one this flow has already produced in production: two orphaned organizations
// holding 10 properties and 20 bookings of guest PII, alive with zero members
// and therefore invisible to every RLS policy in the schema.
// ============================================================================

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** Runs every step, in order, so the ordering assertions below mean something. */
function makeStep() {
  return {
    run: vi.fn(async (_name: string, cb: () => unknown) => cb()),
    sleep: vi.fn(async () => undefined),
    sendEvent: vi.fn(async () => undefined),
  }
}

interface QueuedByTable { [table: string]: { error?: unknown }[] }

function makeAdmin(
  queued: QueuedByTable = {},
  opts: { deleteUserError?: { message: string; status?: number } } = {},
) {
  const counters: Record<string, number> = {}
  const order: string[] = []
  const eqCalls: { table: string; column: string; value: unknown }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.delete = vi.fn(() => { order.push(`delete:${table}`); return chain })
    chain.select = vi.fn(() => chain)
    chain.not    = vi.fn(() => chain)
    chain.neq    = vi.fn(() => chain)
    chain.limit  = vi.fn(() => chain)
    chain.eq = vi.fn((column: string, value: unknown) => {
      eqCalls.push({ table, column, value })
      return chain
    })
    chain.then = (resolve: (v: unknown) => unknown) => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { error: null }).then(resolve)
    }
    return chain
  })

  const deleteUser = vi.fn(async (_id: string) => {
    order.push('deleteUser')
    return { error: opts.deleteUserError ?? null }
  })

  return { from, order, eqCalls, auth: { admin: { deleteUser } } }
}

const USER_ID = 'user_1'

function run(admin: ReturnType<typeof makeAdmin>, ownedOrgIds: string[]) {
  ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(admin)
  return invokeHandler(accountDeletion, {
    event:  { data: { user_id: USER_ID, owned_org_ids: ownedOrgIds } },
    step:   makeStep(),
    logger: makeLogger(),
  })
}

describe('accountDeletion', () => {
  beforeEach(() => vi.clearAllMocks())

  it('purges every non-cascading table, THEN the organization, THEN the auth user', async () => {
    // The order is the whole safety property, in both directions:
    //
    //  * Tables before the organization, because work_order_invoices and
    //    work_orders hold RESTRICT / NO ACTION edges INTO the cascade tree and
    //    Postgres does not order cascade actions — left to the cascade they
    //    abort the organizations DELETE with an FK violation.
    //  * Organization before the auth user, because while the user exists the
    //    tenant is reachable and the purge is re-drivable. Reverse it and a
    //    failed purge becomes an orphan nobody can find.
    const admin = makeAdmin()

    await run(admin, ['org_1'])

    for (const table of ORG_PURGE_TABLES) {
      expect(admin.order).toContain(`delete:${table}`)
      expect(admin.order.indexOf(`delete:${table}`))
        .toBeLessThan(admin.order.indexOf('delete:organizations'))
    }
    expect(admin.order.indexOf('delete:organizations'))
      .toBeLessThan(admin.order.indexOf('deleteUser'))
  })

  it('scopes every purge to the org, and the organization delete to its id', async () => {
    const admin = makeAdmin()

    await run(admin, ['org_1'])

    for (const table of ORG_PURGE_TABLES) {
      expect(admin.eqCalls).toContainEqual({ table, column: 'org_id', value: 'org_1' })
    }
    expect(admin.eqCalls).toContainEqual({ table: 'organizations', column: 'id', value: 'org_1' })
  })

  it('deletes the auth user even when the caller owned no organizations', async () => {
    // A member who owns nothing still has an account to delete; their
    // organization_members rows go with the auth-user cascade.
    const admin = makeAdmin()

    await run(admin, [])

    expect(admin.order).toEqual(['deleteUser'])
  })

  it('THROWS rather than continuing when a table purge fails — the auth user must survive a failed purge', async () => {
    // The route used to return a 500 here and leave the caller to notice.
    // Throwing gets the Inngest retry and, on exhaustion, the dead-letter
    // founder alert. Continuing to deleteUser would produce exactly the
    // orphaned tenant this whole flow exists to prevent.
    const admin = makeAdmin({ work_order_invoices: [{ error: { message: 'deadlock detected' } }] })

    await expect(run(admin, ['org_1'])).rejects.toThrow(/failed to purge work_order_invoices/)

    expect(admin.order).not.toContain('delete:organizations')
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ site: 'inngest.account-deletion.purge_org' }),
    )
  })

  it('THROWS rather than continuing when the organization delete itself fails', async () => {
    const admin = makeAdmin({ organizations: [{ error: { message: 'deadlock detected' } }] })

    await expect(run(admin, ['org_1'])).rejects.toThrow(/failed to delete organization org_1/)

    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
  })

  it('throws when the final auth-user deletion fails', async () => {
    const admin = makeAdmin({}, { deleteUserError: { message: 'auth service down' } })

    await expect(run(admin, [])).rejects.toThrow(/deleteUser failed/)
  })

  it('treats an already-deleted auth user as success — that is the retry case, not a failure', async () => {
    // The previous attempt got all the way here and died on the response. Any
    // other error still throws.
    const admin = makeAdmin({}, { deleteUserError: { message: 'User not found' } })

    await expect(run(admin, [])).resolves.toEqual({ orgs_purged: 0 })
  })

  it('treats a 404 status as already-deleted even when the message would not match the not-found regex', async () => {
    // A brittle regex against error.message is fragile against wording drift
    // in a third-party (Supabase GoTrue) error string this codebase does not
    // control. The HTTP status is the real signal.
    const admin = makeAdmin({}, { deleteUserError: { message: 'Auth admin error', status: 404 } })

    await expect(run(admin, [])).resolves.toEqual({ orgs_purged: 0 })
    expect(reportError).not.toHaveBeenCalled()
  })

  it('still throws a non-404 error whose message does not mention not-found', async () => {
    const admin = makeAdmin({}, { deleteUserError: { message: 'auth service down', status: 500 } })

    await expect(run(admin, [])).rejects.toThrow(/deleteUser failed/)
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ site: 'inngest.account-deletion.delete_user' }),
    )
  })

  it('refuses a payload with more organizations than one run should ever carry, instead of truncating it', async () => {
    // Every org in the payload is one the caller OWNS and is the SOLE member
    // of, so this shape cannot be produced by the route. Truncating would
    // silently leave tenants unpurged with nothing to revisit them; throwing
    // dead-letters the whole list, intact, to the founder inbox.
    const admin = makeAdmin()
    const many  = Array.from({ length: 26 }, (_, i) => `org_${i}`)

    await expect(run(admin, many)).rejects.toThrow(/refusing to purge 26 organizations/)

    expect(admin.order).toEqual([])
  })

  describe('sole-member re-verification (TOCTOU)', () => {
    // assertSoleMember checked this ONCE, synchronously, when the deletion
    // was requested. This function runs asynchronously and can be delayed by
    // retries, so a member invited (or who finally accepted) between the
    // request and this run must not be purged along with the requester's
    // data — the route's promise has to be re-checked at execution time, not
    // just trusted from the stale event payload.

    it('refuses to purge an org that gained another accepted member since the request', async () => {
      // The query itself excludes the requester (.neq('user_id', user_id)),
      // so this fixture represents exactly what a real query would return:
      // only OTHER accepted members.
      const admin = makeAdmin({
        organization_members: [{ data: [{ user_id: 'user_2' }], error: null } as never],
      })

      await expect(run(admin, ['org_1']))
        .rejects.toThrow(/org_1 is no longer sole-member-owned/)

      // Nothing purged — not even the tables, let alone the organization or
      // the auth user.
      expect(admin.order).toEqual([])
      expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
      expect(reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ site: 'inngest.account-deletion.sole-member-race' }),
      )
    })

    it('proceeds normally when the requester is still the only accepted member', async () => {
      // No OTHER accepted members — the query's own .neq('user_id', user_id)
      // means a real result here never includes the requester's own row.
      const admin = makeAdmin({
        organization_members: [{ data: [], error: null } as never],
      })

      await run(admin, ['org_1'])

      expect(admin.order).toContain('delete:organizations')
      expect(admin.auth.admin.deleteUser).toHaveBeenCalled()
    })

    it('treats a null data array (no rows) the same as empty — still proceeds', async () => {
      const admin = makeAdmin({
        organization_members: [{ data: null, error: null } as never],
      })

      await expect(run(admin, ['org_1'])).resolves.toEqual({ orgs_purged: 1 })
    })

    it('throws rather than purging when the re-check read itself fails', async () => {
      const admin = makeAdmin({
        organization_members: [{ error: { message: 'connection reset' } } as never],
      })

      await expect(run(admin, ['org_1']))
        .rejects.toThrow(/sole-member re-check failed for org org_1/)

      expect(admin.order).toEqual([])
      expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
    })

    it('re-verifies EVERY org independently in a multi-org run — one racing org must not block the others', async () => {
      const admin = makeAdmin({
        organization_members: [
          { data: [], error: null } as never,                 // org_1: still sole
          { data: [{ user_id: 'user_2' }], error: null } as never, // org_2: raced
        ],
      })

      await expect(run(admin, ['org_1', 'org_2']))
        .rejects.toThrow(/org_2 is no longer sole-member-owned/)

      // org_1 was fully purged before the org_2 check failed and stopped the run.
      expect(admin.order).toContain('delete:organizations')
    })
  })

  describe('final sweep of non-cascading tables (race window before the org delete)', () => {
    // Nothing locks the org against new writes between the first purge pass
    // over ORG_TABLES_WITHOUT_CASCADE and the organizations delete — a crew
    // member's own session is untouched by this flow (the sole-member check
    // is about organization_members, not crew_members). A write that lands
    // in that window is caught by neither the already-run purge step nor the
    // organizations cascade (these tables have no FK to organizations at
    // all), so it survives, orphaned. A second sweep immediately before the
    // org delete closes that window.

    it('re-sweeps every non-cascading table a second time, immediately before the organization delete', async () => {
      const admin = makeAdmin()

      await run(admin, ['org_1'])

      for (const table of ORG_TABLES_WITHOUT_CASCADE) {
        const occurrences = admin.order.filter((entry) => entry === `delete:${table}`).length
        expect(occurrences).toBe(2)
      }
      // Tables that already cascade correctly (or block it and must run
      // exactly once, before the cascade) get no second sweep — they were
      // never the race window this closes.
      for (const table of ORG_TABLES_BLOCKING_CASCADE) {
        const occurrences = admin.order.filter((entry) => entry === `delete:${table}`).length
        expect(occurrences).toBe(1)
      }
    })

    it('runs the final sweep after the first purge pass and before the organization delete', async () => {
      const admin = makeAdmin()

      await run(admin, ['org_1'])

      const orgIdx = admin.order.indexOf('delete:organizations')
      for (const table of ORG_TABLES_WITHOUT_CASCADE) {
        const lastIdx = admin.order.lastIndexOf(`delete:${table}`)
        expect(lastIdx).toBeGreaterThan(admin.order.indexOf(`delete:${table}`)) // a real second occurrence
        expect(lastIdx).toBeLessThan(orgIdx)
      }
    })

    it('THROWS rather than continuing when the final sweep fails, and never deletes the organization', async () => {
      // The first purge pass over crew_availability succeeds; the final
      // sweep for the same table is what fails.
      const admin = makeAdmin({ crew_availability: [{ error: null }, { error: { message: 'deadlock detected' } }] })

      await expect(run(admin, ['org_1'])).rejects.toThrow(/final sweep failed for crew_availability\/org_1/)

      expect(admin.order).not.toContain('delete:organizations')
      expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled()
      expect(reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ site: 'inngest.account-deletion.purge_org_final_sweep' }),
      )
    })
  })

  it('is registered as a critical function, so a retry-exhausted purge reaches a human', async () => {
    // The user cannot retry this — their session is gone by the time it runs,
    // and on the final failure nobody is left who can see the tenant. The
    // dead-letter alert is the only path back, which makes membership here a
    // correctness property rather than a preference.
    expect(CRITICAL_FUNCTION_IDS.has('account-deletion')).toBe(true)
  })
})
