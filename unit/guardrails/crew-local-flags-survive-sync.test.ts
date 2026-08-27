import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, readCode } from './scan'

// ============================================================================
// A PM PREFERENCE ON A PROVIDER-SYNCED CREW ROW MUST SURVIVE THE NEXT SYNC.
//
// crew_members rows for Hospitable and Hostex staff are rewritten by a DAILY
// cron via `.upsert(..., { onConflict: 'org_id,external_id,external_source' })`.
// PostgREST builds that as ON CONFLICT DO UPDATE SET <one assignment per column
// present in the payload> — so a column the payload omits keeps its stored
// value, and a column the payload names is overwritten every single night.
//
// That makes the row builders' column list the entire mechanism protecting any
// locally-set field. `crew_members.auto_assign_eligible` (20260827034958) is
// one: the PM ticks a box saying whether this person may be picked by turnover
// auto-assignment, and nothing upstream has an opinion about it.
//
// Verified empirically before writing this, not inferred from reading the
// upsert: a crew row was set to auto_assign_eligible = false on the E2E
// project, then a byte-accurate replica of the Hospitable sync payload was
// upserted over it. The flag stayed false while `specialty` changed from null
// to 'Cleaning' — proving the upsert really fired and really left the flag
// alone. So the current state is CORRECT; this exists so it stays that way,
// because "correct by omission" is one autocompleted line from being wrong.
//
// The risk is not hypothetical on this exact code path. lib/inngest/functions/
// hostex/staff-sync.ts carries `preserveManualCrewRoles()` because `role` WAS
// in the payload and a PM's role edit was reverted by the next night's sync
// (fixed 2026-08-17). The Hospitable teammate sync still has no equivalent, so
// the same defect is live there for `role` today — see that handler. A flag
// added to a payload here fails silently and invisibly: the write succeeds, the
// UI shows the PM's choice until the cron runs, and by morning it is gone.
// ============================================================================

/**
 * crew_members columns owned by the PM, never by a provider.
 *
 * Grow this when a new local-only preference column is added to crew_members —
 * that is the point of the list.
 *
 * NOT `is_active`, deliberately. Both providers put it in the payload on
 * purpose: Hostex mirrors its own `is_active` so a staff member it deactivated
 * arrives deactivated, and Hospitable forces true because its deactivation is
 * expressed by absence from the fetch and handled by a separate reconcile pass.
 * Those are designed behaviours, not oversights, and banning the column here
 * would break both syncs.
 *
 * NOT `role` either, for a less comfortable reason: it IS in both payloads, and
 * on the Hospitable side that is the unfixed bug described above. Adding it
 * here would fail immediately and say nothing new. It belongs in the fix.
 */
const LOCAL_ONLY_CREW_COLUMNS = ['auto_assign_eligible'] as const

/**
 * Where a provider crew row is built or written.
 *
 * Both halves are scanned because they are separate files: the sync handler
 * runs the upsert, but the payload is assembled by a mapper in
 * lib/integrations/providers/, so a check on the handler alone would miss the
 * line that actually does the damage.
 */
const PROVIDER_SYNC_DIRS = [
  'lib/integrations',
  'lib/inngest/functions/hospitable',
  'lib/inngest/functions/hostex',
  'lib/inngest/functions/hostaway',
  'lib/inngest/functions/ownerrez',
]

function offendersFor(column: string): string[] {
  return collectSourceFiles(PROVIDER_SYNC_DIRS)
    // readCode, not read: this file's own rationale names the column repeatedly
    // in prose, and so will any handler that documents why it leaves the column
    // alone. A raw scan would report the explanation as the violation.
    .filter((file) => new RegExp(`\\b${column}\\b`).test(readCode(file)))
    .map(rel)
}

describe('guardrail: PM-owned crew flags survive a provider sync', () => {
  it('no provider mapper or sync handler writes a local-only crew column', () => {
    for (const column of LOCAL_ONLY_CREW_COLUMNS) {
      expect(
        offendersFor(column),
        `crew_members.${column} is set by the PM, but a provider sync path names it. ` +
        'A daily upsert would overwrite the PM\'s choice every night, silently — ' +
        'the write succeeds and the UI looks right until the cron runs. Leave the ' +
        'column out of the payload, or preserve it explicitly the way ' +
        'preserveManualCrewRoles() does for role in hostex/staff-sync.ts.',
      ).toEqual([])
    }
  })

  it('SELF-CHECK: the scan can actually fail', () => {
    // A column that IS present in both provider payloads. If this comes back
    // empty the scan is looking in the wrong place, or reading nothing, and the
    // assertion above is decorative — a broken scanner and a clean tree return
    // the identical empty array.
    expect(offendersFor('capacity_score').length).toBeGreaterThan(0)
  })
})
