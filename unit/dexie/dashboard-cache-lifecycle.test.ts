// Runs against real (fake-indexeddb) IndexedDB rather than a stub, because the
// thing under test IS storage lifecycle: which databases exist afterwards.
// A mock of indexedDB.databases() would let both the correct implementation and
// a broken one pass, since the assertion would only be reading back what the
// mock was told.
import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  cleanupStaleDashboardDbs,
  closeDashboardDb,
  dashboardDbName,
  getDashboardDb,
  purgeDashboardDbsForUser,
} from '@/lib/dexie/dashboard/schema'

// ============================================================================
// docs/INSPECTIONS_SPEC.md §8: "IndexedDB survives sign-out unless something
// explicitly clears it, so a PM removed from an org keeps a readable copy of
// that org's maintenance board on their tablet indefinitely." The dashboard
// cache holds costs, vendor contacts and owner-adjacent detail — more than the
// crew PWA does.
//
// §8 also says why this is tested now rather than later: "This needs to be
// built in phase 1 rather than retrofitted, because the version that works
// without it looks identical."
// ============================================================================

const USER_A = '11111111-2222-3333-4444-555555555555'
const USER_B = '99999999-8888-7777-6666-555555555555'
const ORG_1  = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ORG_2  = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb'

/** Create the database for real, then release the handle so it can be deleted. */
async function materialize(userId: string, orgId: string): Promise<void> {
  const db = getDashboardDb(userId, orgId)
  await db.open()
  db.close()
  closeDashboardDb()
}

async function existingNames(): Promise<string[]> {
  const dbs = await indexedDB.databases()
  return dbs.map((d) => d.name!).filter(Boolean).sort()
}

async function deleteAll(): Promise<void> {
  closeDashboardDb()
  for (const name of await existingNames()) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror   = () => resolve()
      req.onblocked = () => resolve()
    })
  }
}

describe('dashboard cache lifecycle', () => {
  beforeEach(deleteAll)

  it('the org switch clears the previous org, not just another user', async () => {
    // The case a `startsWith(userId)` staleness test would silently pass while
    // leaving the other org's board readable on the device.
    await materialize(USER_A, ORG_1)
    await materialize(USER_A, ORG_2)
    expect(await existingNames()).toHaveLength(2)

    await cleanupStaleDashboardDbs(USER_A, ORG_2)

    expect(await existingNames()).toEqual([dashboardDbName(USER_A, ORG_2)])
  })

  it('a second PM on the same device clears the first', async () => {
    await materialize(USER_A, ORG_1)
    await materialize(USER_B, ORG_1)

    await cleanupStaleDashboardDbs(USER_B, ORG_1)

    expect(await existingNames()).toEqual([dashboardDbName(USER_B, ORG_1)])
  })

  it('the cleanup keeps the current pair — it is not simply deleting everything', async () => {
    // Paired with the two tests above deliberately: "delete all dashboard DBs"
    // would satisfy both of them perfectly and destroy the live cache.
    await materialize(USER_A, ORG_1)

    await cleanupStaleDashboardDbs(USER_A, ORG_1)

    expect(await existingNames()).toEqual([dashboardDbName(USER_A, ORG_1)])
  })

  it('never touches a crew or vendor database', async () => {
    // The regression the CLEANABLE_DB_PREFIXES comment records, in the other
    // direction: a crew login on a shared device once destroyed a vendor's
    // queued, never-uploaded work-order completion.
    const crew   = new (await import('dexie')).default(`fieldstay-crew-${USER_A}`)
    crew.version(1).stores({ t: 'id' }); await crew.open(); crew.close()
    const vendor = new (await import('dexie')).default('fieldstay-vendor-wo-abc123')
    vendor.version(1).stores({ t: 'id' }); await vendor.open(); vendor.close()
    await materialize(USER_A, ORG_1)

    // Sweep as a DIFFERENT user, which is when deletion actually happens.
    await cleanupStaleDashboardDbs(USER_B, ORG_2)

    const remaining = await existingNames()
    expect(remaining).toContain(`fieldstay-crew-${USER_A}`)
    expect(remaining).toContain('fieldstay-vendor-wo-abc123')
    expect(remaining).not.toContain(dashboardDbName(USER_A, ORG_1))
  })

  it('sign-out purges every org this user had open', async () => {
    // cleanupStaleDashboardDbs cannot serve here: it is defined relative to a
    // current pair, and at sign-out there is no current pair.
    await materialize(USER_A, ORG_1)
    await materialize(USER_A, ORG_2)
    await materialize(USER_B, ORG_1)

    await purgeDashboardDbsForUser(USER_A)

    expect(await existingNames()).toEqual([dashboardDbName(USER_B, ORG_1)])
  })

  it('sign-out leaves the other principals alone', async () => {
    const crew = new (await import('dexie')).default(`fieldstay-crew-${USER_A}`)
    crew.version(1).stores({ t: 'id' }); await crew.open(); crew.close()
    await materialize(USER_A, ORG_1)

    await purgeDashboardDbsForUser(USER_A)

    expect(await existingNames()).toEqual([`fieldstay-crew-${USER_A}`])
  })

  it('getDashboardDb closes the previous handle when the pair changes', async () => {
    // Not hygiene: an open connection makes deleteDatabase() fire `blocked` and
    // resolve without deleting, which is how an org switch silently fails to
    // clear the previous org's cache.
    const first = getDashboardDb(USER_A, ORG_1)
    await first.open()
    expect(first.isOpen()).toBe(true)

    getDashboardDb(USER_A, ORG_2)

    expect(first.isOpen()).toBe(false)
  })
})
