import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// organization_members access guardrail.
//
// lib/inngest/helpers.ts declares itself the SINGLE SOURCE OF TRUTH for "who
// is the PM of this org": it applies the invite_accepted_at filter and the
// owner → admin → manager ROLE_PREFERENCE ordering. Nothing enforced that,
// and four Inngest call sites had quietly drifted away from it by the
// 2026-07-30 pre-launch audit:
//
//   - work-order-vendor-assigned.ts, work-order-events-helpers.ts and
//     work-order-events.ts each ran their own `.in('role', ['owner','admin'])
//     .limit(1)` with NO ORDER BY to pick the "dispatcher" named on
//     vendor-facing email and SMS. Postgres returns whatever it likes for an
//     unordered limit, so two messages about the SAME work order could name
//     two different humans for the vendor to call.
//   - flagged-turnover-wo.ts omitted `.not('invite_accepted_at','is',null)`
//     entirely — the exact drift class CLAUDE.md records as having shipped
//     as a live bug three times.
//
// All four now go through getPmMembers()/getOrgDispatcher(). This test is
// what keeps the fifth from happening: a direct organization_members query
// anywhere outside the owning modules has to be added here, with a reason.
//
// This is deliberately a query-shape check, not a "notification code only"
// check — the point is that reaching for the table directly is the thing
// worth a second look, whatever the query turns out to be for.
// ============================================================================

const TABLE_QUERY = /\.from\(\s*['"]organization_members['"]\s*\)/g

// Modules that OWN organization_members access. Everything else needs a
// justified entry in ALLOWED below.
const OWNERS = new Set([
  'lib/auth.ts',              // requireOrgMember / requireOrgRole — the auth boundary itself
  'lib/auth/invites.ts',      // writes the membership row on invite acceptance
  'lib/inngest/helpers.ts',   // getPmMembers / getPmMembersByOrgIds / getOrgDispatcher
])

// Verified against the codebase 2026-07-30. Keyed by file (not line) so an
// unrelated edit above the query doesn't churn this list. Each entry says
// why this file reads the table directly rather than through the helpers.
//
// Adding an entry is a review event, not a formality: if the query picks a
// HUMAN RECIPIENT for a notification, it almost certainly belongs in
// lib/inngest/helpers.ts instead.
const ALLOWED: Record<string, string> = {
  // ── Membership/session resolution: answering "which org is this user in",
  //    not "who should we notify". getPmMembers is the wrong shape for these.
  'lib/integrations/finalize-connection.ts':
    "Resolves the connecting user's own oldest org during OAuth finalization — a self-scoped membership lookup, not recipient selection.",
  'app/billing-wall/page.tsx':
    "Loads the signed-in user's own org + plan status to decide whether to show the billing wall.",
  'app/onboarding/page.tsx':
    "Checks whether the signed-in user already has a membership, to skip completed onboarding steps.",
  'app/api/dashboard/push-subscribe/route.ts':
    "Resolves the caller's own org before storing their push subscription.",
  'app/api/assets/request-scan/route.ts':
    "Resolves the caller's own org (PM member OR crew member) before authorizing the scan request.",
  'app/api/repuguard/generate/route.ts':
    "Resolves the caller's own org before generating review drafts for it.",

  // ── Account/team administration: the membership rows ARE the subject.
  'app/(dashboard)/maintenance/page.tsx':
    'Populates the §7 "who walks it" picker on the schedule form with the ' +
    "org's accepted members. NOT recipient selection — it renders a dropdown, " +
    'and nothing is notified from here. getPmMembersByOrgIds is the wrong ' +
    'tool despite the surface similarity: it takes a SERVICE client and ' +
    'resolves mailboxes through the GoTrue Admin API, so using it would push ' +
    'a service-role client into a Server Component to fill a <select> — ' +
    'exactly the RLS-bypass CLAUDE.md says to avoid unless the page needs it.',

  'app/(dashboard)/maintenance/actions.ts':
    "resolveScheduleRouting verifies that a §7 inspection schedule's " +
    'assigned_to_user_id is a member of the caller\'s org. A TENANT-ISOLATION ' +
    'check on a client-supplied id, the org-member sibling of ' +
    'checkCrewMemberAssignable — not recipient selection, so getPmMembers is ' +
    'the wrong shape: it filters by role and returns a map, where this needs ' +
    '"is this one id in this one org, with the invite accepted".',

  'app/(dashboard)/settings/team/actions.ts':
    'Team management — invites, role changes, and member removal operate on membership rows directly by definition.',
  'app/(dashboard)/settings/team/page.tsx':
    'Renders the full member roster for the team settings screen; a PM-recipient helper would return the wrong set.',
  'app/api/account/delete/route.ts':
    'Account deletion: counts remaining members to detect last-owner, and enumerates the deleting user\'s own memberships.',
  'app/api/gdpr/export/route.ts':
    "GDPR export of the requesting user's own membership rows, verbatim.",

  // NOTE: the three batched cron reads that used to be allowlisted here
  // (cron/daily-wrapup.ts, cron/stale-feed-alert.ts,
  // hospitable/calendar-sync-cron.ts) were migrated onto
  // getPmMembersByOrgIds() on 2026-08-01 and no longer touch the table. Each
  // had re-derived the helper's role ordering and invite_accepted_at filter by
  // hand — the drift class semgrep's fieldstay-role-filtered-membership-read
  // now gates at --error, having reached 0 with that migration.

  // ── Infrastructure.
  'app/api/health/route.ts':
    'Liveness probe — a minimal SELECT 1-shaped round-trip that returns no member data.',

  // The two KNOWN DRIFT entries that shipped with this guardrail
  // (app/api/webhooks/stripe/handlers/core-billing.ts and
  // app/(dashboard)/messages/actions.ts) were fixed on 2026-07-31 — both now
  // pick their recipient via getPmMembers() and no longer touch the table.
}

function findQuerySites(): string[] {
  const sites: string[] = []
  for (const file of collectSourceFiles(['app', 'lib'])) {
    const path = rel(file)
    if (OWNERS.has(path)) continue
    TABLE_QUERY.lastIndex = 0
    if (TABLE_QUERY.test(read(file))) sites.push(path)
  }
  return sites.sort()
}

describe('guardrail: organization_members is read through lib/inngest/helpers.ts', () => {
  const sites = findQuerySites()

  it('sanity: the scan actually finds the known query sites', () => {
    // If this drops to zero the regex has stopped matching and every
    // assertion below would pass vacuously.
    expect(sites.length).toBeGreaterThan(5)
  })

  it('no unlisted file queries organization_members directly', () => {
    const unlisted = sites.filter((s) => !(s in ALLOWED))
    expect(
      unlisted,
      `These files query organization_members directly without going through
lib/inngest/helpers.ts (getPmMembers / getPmEmails / getOrgDispatcher).

If the query picks who to NOTIFY, use the helper — it is the only place
that applies the invite_accepted_at filter and the owner → admin → manager
ordering, and skipping it is what made the vendor-facing "dispatcher" name
nondeterministic before the 2026-07-30 audit.

If it genuinely isn't recipient selection, add the file to ALLOWED in
unit/guardrails/organization-members-access.test.ts with the reason.

Offenders:\n${unlisted.join('\n')}`,
    ).toEqual([])
  })

  it('the ALLOWED list only shrinks — no stale entries', () => {
    const stale = Object.keys(ALLOWED).filter((f) => !sites.includes(f))
    expect(
      stale,
      `These ALLOWED entries no longer query organization_members (fixed, moved,
or deleted). Remove them so the list keeps shrinking:\n${stale.join('\n')}`,
    ).toEqual([])
  })
})
