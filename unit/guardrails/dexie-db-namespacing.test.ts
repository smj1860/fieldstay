import { describe, expect, it } from 'vitest'

import {
  DASHBOARD_DB_PREFIX,
  dashboardDbName,
  isStaleDashboardDbName,
} from '@/lib/dexie/dashboard/schema'
import { isStaleCrewDbName } from '@/lib/dexie/schema'

// ============================================================================
// THREE PRINCIPALS SHARE ONE ORIGIN'S IndexedDB, AND EACH CLEANS UP ONLY ITSELF.
//
//   crew      fieldstay-crew-{userId} / fieldstay-photo-queue-{userId}
//   vendor    fieldstay-vendor-wo-{token}
//   dashboard fieldstay-dash-{userId}-{orgId}
//
// A cleanup that reaches past its own prefix destroys someone else's unsent
// work. That is not hypothetical: the comment on CLEANABLE_DB_PREFIXES records
// a crew login on a shared device destroying a vendor's queued, never-uploaded
// work-order completion, because a link token is not a user id and so never
// "contains" one.
//
// The dashboard adds the sharper version of the same trap. Its suffix is
// `{userId}-{orgId}`, which never EQUALS `{userId}` — so if its prefix were
// added to the crew cleanup's list, every crew-context mount would delete the
// PM's live dashboard cache as "belonging to another user". And in the other
// direction, a `startsWith(userId)` staleness test would spare every org of the
// current user, which is precisely the org-switch case §8 requires be cleared.
//
// Both ids are UUIDs, and UUIDs are full of hyphens, so nothing may parse these
// names by splitting. Compare them whole.
// ============================================================================

const USER_A = '11111111-2222-3333-4444-555555555555'
const USER_B = '99999999-8888-7777-6666-555555555555'
const ORG_1  = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ORG_2  = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb'

const CREW_A      = `fieldstay-crew-${USER_A}`
const PHOTOS_A    = `fieldstay-photo-queue-${USER_A}`
const VENDOR_LINK = 'fieldstay-vendor-wo-3f9c1d2e8a7b4c6d'
const DASH_A1     = dashboardDbName(USER_A, ORG_1)

describe('guardrail: each Dexie principal cleans up only its own databases', () => {
  it('the dashboard cleanup never claims a crew or vendor database', () => {
    for (const foreign of [CREW_A, PHOTOS_A, VENDOR_LINK]) {
      expect(isStaleDashboardDbName(foreign, USER_A, ORG_1),
        `${foreign} must be invisible to the dashboard cleanup`).toBe(false)
      // …including for a DIFFERENT user, which is the case that actually
      // deletes things: "not mine" must still mean "not mine to delete".
      expect(isStaleDashboardDbName(foreign, USER_B, ORG_2),
        `${foreign} must be invisible to the dashboard cleanup`).toBe(false)
    }
  })

  it('the crew cleanup never claims a dashboard database', () => {
    // The specific regression: `fieldstay-dash-{userA}-{org1}` does not end in
    // `{userA}`, so a prefix-based crew cleanup that could see it would judge
    // it stale and delete a live cache — including its queued, unsent work
    // orders. The protection is that the crew prefixes do not match it at all.
    expect(isStaleCrewDbName(DASH_A1, USER_A), 'crew cleanup must not see dashboard DBs').toBe(false)
    expect(isStaleCrewDbName(DASH_A1, USER_B), 'crew cleanup must not see dashboard DBs').toBe(false)
  })

  it('the crew cleanup still claims a stale crew database (it is not simply blind)', () => {
    // Paired with the test above on purpose. "Never deletes anything" would
    // pass that one perfectly.
    expect(isStaleCrewDbName(CREW_A, USER_B)).toBe(true)
    expect(isStaleCrewDbName(PHOTOS_A, USER_B)).toBe(true)
    expect(isStaleCrewDbName(CREW_A, USER_A)).toBe(false)
  })

  it('a different ORG for the SAME user is stale — this is the org switch', () => {
    expect(isStaleDashboardDbName(dashboardDbName(USER_A, ORG_2), USER_A, ORG_1)).toBe(true)
    // A `startsWith(userId)` test would return false here and leave the
    // previous org's board — costs, vendor contacts, owner-adjacent detail —
    // readable on the device.
  })

  it('a different USER on the same device is stale', () => {
    expect(isStaleDashboardDbName(dashboardDbName(USER_B, ORG_1), USER_A, ORG_1)).toBe(true)
    expect(isStaleDashboardDbName(dashboardDbName(USER_B, ORG_2), USER_A, ORG_1)).toBe(true)
  })

  it('the current pair is never stale', () => {
    expect(isStaleDashboardDbName(DASH_A1, USER_A, ORG_1)).toBe(false)
  })

  it('no prefix is a prefix of another', () => {
    // What keeps all of the above true as names are added. `fieldstay-` on its
    // own would match every principal, which is the mistake the crew list's
    // comment exists to prevent.
    const prefixes = [
      'fieldstay-crew-',
      'fieldstay-photo-queue-',
      'fieldstay-vendor-wo-',
      DASHBOARD_DB_PREFIX,
    ]
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue
        expect(a.startsWith(b), `${a} starts with ${b} — one cleanup can reach the other`).toBe(false)
      }
    }
  })

  it('names are compared whole, never split on the hyphen', () => {
    // A UUID contains four hyphens, so `name.split('-')` finds no meaningful
    // boundary between the user and the org. This asserts the shape that makes
    // splitting obviously wrong, so the next reader does not try it.
    const suffix = DASH_A1.slice(DASHBOARD_DB_PREFIX.length)
    expect(suffix).toBe(`${USER_A}-${ORG_1}`)
    expect(suffix.split('-').length).toBeGreaterThan(2)
  })
})
