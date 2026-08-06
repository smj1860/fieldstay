'use server'

import { redirect, unstable_rethrow } from 'next/navigation'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'
import { reportError } from '@/lib/observability/report-error'

// ============================================================================
// This step advances the setup wizard. It does NOT own maintenance-schedule
// CRUD, and the three actions that used to live here have been deleted:
//
//   • addMaintenanceSchedule       — orphaned when the inline "Build Custom
//     Schedule" form was removed for the Templates Hub hybrid decision. It was
//     a divergent duplicate of createMaintenanceSchedule (app/(dashboard)/
//     maintenance/actions.ts), and divergent in two ways that mattered: it
//     gated on requireOrgMember() rather than requireOrgRole(['admin',
//     'manager']), and it computed next_due_date ONLY for seasonal schedules —
//     leaving every routine schedule it created with a NULL due date. The
//     maintenance cron filters on `.lt('next_due_date', today)` / `.lte(...)`,
//     which NULL never satisfies, and it only ever ADVANCES an existing date,
//     never bootstraps a missing one. A routine schedule created here was
//     therefore permanently dormant: no work order, ever, and nothing to
//     reveal it — the daily wrap-up's due section filters on the same column.
//   • deleteMaintenanceSchedule    — a second copy of the same-named live
//     action in app/(dashboard)/maintenance/actions.ts, which is what
//     schedules-browser.tsx and maintenance-board.tsx actually call. The
//     shared name is why unreferenced-server-actions never flagged this one:
//     its matcher looks for a bare identifier anywhere in the tree, so the
//     live action's call sites masked the dead one.
//   • cloneMaintenanceFromProperty — superseded by the property-clone flow in
//     app/(dashboard)/properties/clone-actions.ts, which already copies
//     maintenance schedules along with everything else. The two disagreed on
//     semantics (this one skipped by name and kept the target's existing
//     schedules; clone-actions deactivates them first), so keeping both meant
//     two different answers to "what does cloning a property do".
//
// A custom schedule is built at Templates → Maintenance → Create Template,
// which the step now links to directly.
// ============================================================================

export async function completeMaintenanceStep(propertyId: string): Promise<void> {
  try {
    await markStepComplete(propertyId, 'maintenance')
    redirect(`/properties/${propertyId}/setup/crew`)
  } catch (err) {
    unstable_rethrow(err)
    console.error('[completeMaintenanceStep]', err)
    reportError(err, { site: 'serverAction.properties.setup.maintenance.completeMaintenanceStep' })
    throw err
  }
}
