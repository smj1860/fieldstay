import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Work-order completion guardrail.
//
// Completing a work order is not "write status = 'completed'". It also has to
// fire `work-order/completed` (which posts the maintenance expense to
// owner_transactions), stamp completed_date, write the work_order_updates
// audit row, and advance the source maintenance schedule's next_due_date.
//
// Three PM-side paths complete a work order — updateWorkOrderStatus and
// bulkUpdateWorkOrderStatus (app/(dashboard)/maintenance/actions.ts) and
// markWorkVerified (app/(dashboard)/maintenance/work-order-actions.ts, the WO
// detail "verify" button). Two of the three did the status write and nothing
// else, silently: a month-end bulk completion of ten recurring WOs left the
// owner P&L short ten maintenance expenses and left ten schedules on their old
// next_due_date, so the cron re-created the same work orders. CI was green.
//
// Both halves now live in ./app/(dashboard)/maintenance/
// complete-work-order-helpers.ts, and this test says: a file that writes the
// completion COLUMNS must also run the completion SIDE EFFECTS. That is the
// invariant a fourth completion path would otherwise re-break — a per-file
// lint rule cannot see it, because each half is individually valid code.
// ============================================================================

const HELPERS = 'app/(dashboard)/maintenance/complete-work-order-helpers.ts'

const COLUMN_WRITER    = /workOrderCompletionFields\s*\(/
const SIDE_EFFECT_CALL = /finalizeWorkOrderCompletion\s*\(/

describe('guardrail: every work-order completion path runs the completion side effects', () => {
  it('a file that writes the completion columns also calls finalizeWorkOrderCompletion', () => {
    const offenders: string[] = []

    for (const file of collectSourceFiles(['app'])) {
      const path = rel(file)
      if (path === HELPERS) continue          // the helpers module defines both
      const src = read(file)
      if (!COLUMN_WRITER.test(src)) continue
      if (!SIDE_EFFECT_CALL.test(src)) offenders.push(path)
    }

    expect(
      offenders.length === 0
        ? []
        : [
            'These files stamp a work order completed but never run the completion',
            'side effects (work-order/completed → the owner_transactions maintenance',
            'expense, the work_order_updates row, and the source-schedule advance).',
            'Call finalizeWorkOrderCompletion() with the rows the completing UPDATE',
            `returned (select ${'COMPLETED_WORK_ORDER_SELECT'} off it). Offenders:`,
            ...offenders,
          ].join('\n')
    ).toEqual([])
  })

  it('the completion helpers module is actually wired into all three PM paths', () => {
    const callers = collectSourceFiles(['app'])
      .filter((f) => rel(f) !== HELPERS && SIDE_EFFECT_CALL.test(read(f)))
      .map(rel)
      .sort()

    // Not an exact-match assertion: a new completion path is welcome, it just
    // has to go through the helper. These two must never fall off the list.
    expect(callers).toContain('app/(dashboard)/maintenance/actions.ts')
    expect(callers).toContain('app/(dashboard)/maintenance/work-order-actions.ts')
  })
})
