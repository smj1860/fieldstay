import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OPS_EQUIVALENT_ROLES } from '@/lib/auth'
import { ALL_NAV_ITEMS } from '@/lib/navigation'
import type { MemberRole } from '@/types/database'

// ============================================================================
// THE OPS ROLES ARE DEFINED IN THREE PLACES AND MUST SAY THE SAME THING.
//
//   is_org_member()            SQL, migration 20261008120100 — what the DATABASE allows
//   OPS_EQUIVALENT_ROLES       lib/auth.ts                   — what the SERVER ACTION accepts
//   OPS_ROLES                  lib/navigation.ts             — what the user can SEE
//
// They are separate on purpose: a nav item is not a permission, and a Server
// Action guard is not RLS. But a role that passes one layer and not another
// produces the worst kind of bug, because neither half looks wrong on its own:
// a request the app accepts and the database then silently writes nothing for,
// or a page in the nav that errors when opened.
//
// 'operations' and 'maintenance' were added as "everything except billing"
// (20261008120000). The boundary this file really protects is the EXCEPT: the
// roles were given write access by teaching is_org_member to accept them
// wherever 'manager' is accepted, which is one change covering 134 policies,
// and the cost of that leverage is that widening it by accident is also one
// change. The billing and settings assertions below are what make that safe.
// ============================================================================

const OPS_ROLES: readonly MemberRole[] = ['operations', 'maintenance']

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261008120100_is_org_member_ops_role_equivalence.sql'),
  'utf8',
)

describe('guardrail: ops roles agree across SQL, Server Actions and nav', () => {
  it('lib/auth.ts names exactly the roles the SQL names', () => {
    expect([...OPS_EQUIVALENT_ROLES].sort()).toEqual([...OPS_ROLES].sort())

    for (const role of OPS_ROLES) {
      expect(
        MIGRATION.includes(`'${role}'::member_role`),
        `is_org_member() does not name '${role}', so it would pass the Server Action and then write nothing`,
      ).toBe(true)
    }
  })

  it('the SQL stands in for manager only, never a blanket pass', () => {
    // The clause must be gated on 'manager' being in the requested array. A
    // blanket `OR role IN (...)` would hand these roles every admin-only policy
    // in the schema, which is the opposite of "everything except billing", and
    // it would look almost identical in a diff.
    expect(
      MIGRATION.includes("'manager'::member_role = ANY(p_roles)"),
      'the ops clause is not gated on manager — these roles would pass admin-only policies',
    ).toBe(true)
  })

  it('every ops role can see the operational nav, and NOT billing or settings', () => {
    const itemRoles = (id: string) =>
      ALL_NAV_ITEMS.find((i) => i.id === id)?.roles ?? []

    for (const role of OPS_ROLES) {
      // The boundary the owner asked for, asserted by name rather than by count
      // so that adding a nav item cannot quietly change what this proves.
      expect(itemRoles('billing'), `'${role}' must not see Billing`).not.toContain(role)
      expect(itemRoles('settings'), `'${role}' must not see Settings`).not.toContain(role)

      // And a representative sample of what they MUST see, so a future refactor
      // that drops them from the nav fails here rather than in support.
      for (const id of ['turnovers', 'maintenance', 'properties', 'crew-manage', 'inventory', 'vendors']) {
        expect(itemRoles(id), `'${role}' should see ${id}`).toContain(role)
      }
    }
  })

  it('the checks can still fire — the nav really does gate on role', () => {
    // A guardrail that reads an empty roles array passes every assertion above
    // while proving nothing. 'crew' is the control: it holds no
    // organization_members row at all and must appear nowhere in the PM nav.
    const everyRole = ALL_NAV_ITEMS.flatMap((i) => i.roles)
    expect(everyRole.length).toBeGreaterThan(20)
    expect(everyRole).not.toContain('crew')
  })
})
