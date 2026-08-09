import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { accountDeletion, ORG_PURGE_TABLES } from '@/lib/inngest/functions/account-deletion'
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
  opts: { deleteUserError?: { message: string } } = {},
) {
  const counters: Record<string, number> = {}
  const order: string[] = []
  const eqCalls: { table: string; column: string; value: unknown }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.delete = vi.fn(() => { order.push(`delete:${table}`); return chain })
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

  it('is registered as a critical function, so a retry-exhausted purge reaches a human', async () => {
    // The user cannot retry this — their session is gone by the time it runs,
    // and on the final failure nobody is left who can see the tenant. The
    // dead-letter alert is the only path back, which makes membership here a
    // correctness property rather than a preference.
    expect(CRITICAL_FUNCTION_IDS.has('account-deletion')).toBe(true)
  })
})
