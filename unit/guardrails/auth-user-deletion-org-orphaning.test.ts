import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Guardrail: deleting an auth user must not orphan the organizations they own.
//
// BLOCKER B-3 (pre-launch audit, 2026-07-30). app/api/account/delete/route.ts
// deleted the auth.users row with the comment "cascades to org data via DB
// foreign keys". That was false: there is no FK from organizations to
// auth.users. Only organization_members.user_id and profiles.id cascade off
// the auth user, so the organizations row — and every org-scoped table hanging
// off it: properties, bookings (guest_name / guest_email), owner_transactions,
// work_orders, guidebook_guest_sms_optins, communication_logs — survived with
// zero member rows. With no members, every RLS policy (get_user_org_ids() /
// is_org_member()) evaluates false for every user, so the data became
// unreachable through the app and was never going to be purged by anything.
//
// It had already happened in production: 2 orphaned orgs holding 10 properties
// and 20 bookings of guest PII, cleaned up by
// supabase/migrations/20260730300000_purge_orphaned_organizations.sql.
//
// The rule this enforces: any file that deletes an auth user must ALSO delete
// the organizations row (i.e. `.from('organizations')` … `.delete()`), or be a
// named EXCEPTIONS entry explaining why the caller provably owns no org.
//
// This is deliberately a coarse file-level check — proving "this specific
// deleteUser call can only be reached for a user with no owned orgs" is a
// dataflow question no regex can answer. The exception list is where that
// reasoning is written down, which is the point: silence is what let B-3 ship.
// The ordering and the fail-closed behaviour of the real flow are covered
// behaviourally in unit/route-handlers/account-delete.test.ts.
// ============================================================================

// Both the raw gotrue call AND the shared rollback helper count as "this file
// deletes an auth user". Recognising only the raw call would mean routing a
// deletion through lib/auth.ts's deleteOrphanedAuthUser() silently exits this
// guardrail — the check would go quiet at the exact moment the code got
// tidier. This test failed when the helper was introduced, which is the
// behaviour worth keeping.
const DELETE_USER = /auth\.admin\.deleteUser\s*\(|deleteOrphanedAuthUser\s*\(/
const DELETES_ORG = /\.from\(\s*['"]organizations['"]\s*\)[\s\S]{0,200}?\.delete\(/

// Every entry is a path where the deleted auth user provably cannot own an
// organization, with the reason. Adding one is a review event, not a formality.
const EXCEPTIONS: Record<string, string> = {
  'app/accept-invite/[token]/actions.ts':
    'Rollback of an auth user created moments earlier in the same request, when acceptOrgInvite() reports it could not attach the membership. The user is seconds old, joined an org someone else already owns (org_invites.org_id), and never created one — there is nothing for it to orphan. Deleting the org here would be catastrophic: it belongs to the inviter.',
  'app/crew-invite/[token]/actions.ts':
    'Same shape as accept-invite: rollback of a just-created crew auth user when the crew_members link UPDATE fails. Crew never own an organization (they hold a crew_members row, not an organization_members one — see lib/auth/invites.ts on why that distinction is load-bearing).',
  'lib/auth.ts':
    'Defines deleteOrphanedAuthUser(), the shared rollback helper the two invite flows above call — it is the mechanism, not a policy decision about what else to delete. Whether a given deletion may orphan an organization is a property of the CALL SITE, and every call site is listed in this table on its own merits. The helper takes a userId it is told to delete and has no way to know what that user owns; putting an organizations delete in here would be wrong for both current callers (see their entries).',
}

function findOffenders(): { file: string; reason: string }[] {
  const offenders: { file: string; reason: string }[] = []
  for (const file of collectSourceFiles(['app', 'lib'])) {
    const src = read(file)
    if (!DELETE_USER.test(src)) continue
    const key = rel(file)
    if (key in EXCEPTIONS) continue
    if (DELETES_ORG.test(src)) continue
    offenders.push({
      file:   key,
      reason: 'deletes an auth user but never deletes the organizations row',
    })
  }
  return offenders
}

describe('guardrail: deleting an auth user must not orphan owned organizations', () => {
  it('every auth-user deletion either deletes the organization too, or is a named exception', () => {
    const offenders = findOffenders()
    expect(
      offenders,
      offenders.length
        ? `These files call auth.admin.deleteUser() without deleting the organizations row:\n` +
          offenders.map((o) => `  - ${o.file}: ${o.reason}`).join('\n') +
          `\n\nDeleting only the auth user leaves the organization and every org-scoped ` +
          `table behind with zero members, unreachable by RLS and never purged (blocker ` +
          `B-3). Delete the organization the user solely owns, or add a justified ` +
          `EXCEPTIONS entry in this file.`
        : '',
    ).toEqual([])
  })

  it('every EXCEPTIONS entry still deletes an auth user (prune when code moves)', () => {
    for (const key of Object.keys(EXCEPTIONS)) {
      const file = collectSourceFiles(['app', 'lib']).find((f) => rel(f) === key)
      expect(file, `EXCEPTIONS lists ${key}, which no longer exists — remove the stale entry.`)
        .toBeDefined()
      expect(
        DELETE_USER.test(read(file as string)),
        `EXCEPTIONS lists ${key}, which no longer calls auth.admin.deleteUser() — remove the stale entry.`,
      ).toBe(true)
    }
  })

  it('the account-deletion purge covers every org-scoped table that has no FK cascade from organizations', () => {
    // Verified against the live schema on 2026-07-30 as the complete set of
    // org_id-bearing tables with NO foreign key to organizations, re-checked
    // 2026-08-09. A sibling migration has been adding those FKs; until every
    // one lands (and even after — a DELETE the cascade already handled is a
    // harmless no-op), the purge must clear them explicitly or the tenant's
    // data survives the organization row.
    //
    // The purge moved OUT of the route on 2026-08-09 (the cascade is one
    // all-or-nothing statement and the route inherits the platform's default
    // maxDuration, so a large tenant could never finish deleting). This
    // asserts against wherever it lives now, and the companion assertion below
    // is what stops it from living nowhere.
    const src = read(
      collectSourceFiles(['lib']).find(
        (f) => rel(f) === 'lib/inngest/functions/account-deletion.ts',
      ) as string,
    )
    for (const table of [
      // Non-cascading FK edges INTO the cascade tree — these abort the
      // organizations DELETE with an FK violation if left to the cascade.
      'work_order_invoices',
      'work_orders',
      // org_id-bearing tables with no FK to organizations at all.
      'asset_depreciation_entries',
      'assignment_outcomes',
      'vendor_assignment_outcomes',
      'crew_availability',
      'inventory_templates',
      'maintenance_schedule_templates',
      'messages',
    ]) {
      expect(
        src.includes(`'${table}'`),
        `lib/inngest/functions/account-deletion.ts must purge '${table}' — it carries org_id but has no ON DELETE CASCADE from organizations, so deleting the organization leaves its rows behind.`,
      ).toBe(true)
    }
  })

  it('the account-deletion route still hands the purge off — moving it must not mean dropping it', () => {
    // The route is the only caller. Relocating the purge into an Inngest
    // function is only safe while something still fires the event; without
    // this, deleting the send would leave a route that authorizes, cancels
    // billing, audits "account.deleted" — and destroys nothing, permanently,
    // with a 202 telling the user it worked.
    const src = read(
      collectSourceFiles(['app']).find(
        (f) => rel(f) === 'app/api/account/delete/route.ts',
      ) as string,
    )
    expect(
      /account\/deletion\.requested/.test(src),
      'app/api/account/delete/route.ts must send account/deletion.requested — it no longer purges anything itself.',
    ).toBe(true)
  })
})
