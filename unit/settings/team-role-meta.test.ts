import { describe, it, expect } from 'vitest'
import { join } from 'node:path'

import { readCode } from '../guardrails/scan'
import { Constants } from '@/types/database'

// ============================================================================
// ROLE_META in the team roster must cover EVERY member_role label.
//
// This test exists because the partial version shipped. The roster renders a
// badge per member via ROLE_META[m.role], the E2E org holds a 'viewer', and
// ROLE_META had only owner/admin/finance — so `undefined.tone` threw inside a
// client component and took the entire /settings/team page to its error
// boundary. A `role as 'owner' | 'admin' | 'finance'` cast in page.tsx had
// told TypeScript the column could not hold anything else, so nothing caught
// it until an e2e positive control went looking for the page heading.
//
// The Record<MemberRole, ...> type now fails the build on a missing key, and
// the cast is gone. This is the second line of defence, and it is not
// redundant: the labels come from `Constants` (GENERATED from the live schema),
// so a label added to the Postgres enum without the TS union catching up fails
// HERE rather than rendering as a crash for whichever org holds that role.
//
// Scanned as source rather than imported: team-client.tsx is a 'use client'
// module whose import graph reaches a 'use server' actions file, and pulling
// that into a unit test to read one constant is not worth the coupling.
// readCode() strips comments first, so this file's own prose cannot satisfy it.
// ============================================================================

const TEAM_CLIENT = join(process.cwd(), 'app/(dashboard)/settings/team/team-client.tsx')

describe('team roster role badges', () => {
  it('has a ROLE_META entry for every member_role label in the live enum', () => {
    const code = readCode(TEAM_CLIENT)

    // The ROLE_META object literal only, so an entry cannot be satisfied by
    // the label appearing anywhere else in the file (a select option, a
    // comparison against membership.role).
    const block = /const ROLE_META[^=]*=\s*\{([\s\S]*?)\n\}/.exec(code)
    expect(block, 'ROLE_META object literal not found in team-client.tsx').not.toBeNull()

    const body = block![1]
    for (const role of Constants.public.Enums.member_role) {
      expect(
        new RegExp(`(^|\\s)${role}:`, 'm').test(body),
        `ROLE_META has no entry for the '${role}' member_role, so a member with that role ` +
        'renders undefined.tone and throws, taking the whole page down',
      ).toBe(true)
    }
  })

  it('reads the labels from the generated enum, not a hand-written list', () => {
    // Guards the guard: if Constants ever stops carrying member_role, the loop
    // above would iterate nothing and pass vacuously.
    expect(Constants.public.Enums.member_role.length).toBeGreaterThanOrEqual(5)
    expect(Constants.public.Enums.member_role).toContain('finance')
  })
})
