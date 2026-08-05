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

// The raw form of the same completion, and the one CLAUDE.md's rule is
// actually phrased against ("Completing a work order by writing
// status: 'completed' yourself"). Keying only on workOrderCompletionFields()
// meant this guardrail could catch a file that had ALREADY half-adopted the
// helper, and was blind to one that never reached for it — which is the state
// a fourth completion path starts in. app/actions/work-order-public.ts's
// submitWorkOrderSignOff sat here undetected.
//
// Scoped to a work_orders UPDATE, not the bare literal. Three live sites write
// status: 'completed' on TURNOVERS, a different table with a different
// completion protocol, and one of them
// (app/api/work-orders/[token]/complete/helpers.ts) does it in a file that
// also reads from work_orders — so a file-level "mentions both" heuristic
// false-positives on it.
//
// The gap between .from() and .update() ties the literal to the right table,
// and it must not be able to cross an intervening `.from(`. A plain bounded
// gap will bridge a work_orders READ into a LATER turnovers update and report
// correct code as a violation — the fixture in the last test below reproduces
// exactly that, and the real helpers.ts escaped a `{0,80}` window only because
// its two statements happen to sit further apart than the window was wide.
// Distance is not a table check; the negated `.from(` is.
const RAW_COMPLETION_WRITE =
  /\.\s*from\(\s*['"]work_orders['"]\s*\)(?:(?!\.\s*from\()[\s\S]){0,200}?\.\s*update\(\s*\{[^}]*?status:\s*['"]completed['"]/

/**
 * Known offenders, each with the reason it is not yet fixed. Shrink-only —
 * never add to this without the same standard of justification.
 */
const EXCEPTIONS: Record<string, string> = {
  'app/actions/work-order-public.ts':
    "submitWorkOrderSignOff, the /wo/[token] vendor portal. It is UNREACHABLE: it " +
    "keys on work_orders.public_token, which no code path writes and which has zero " +
    "rows in production — the live portal is /work-orders/[token] on completion_token. " +
    'Deleting the dead portal is the real fix and is a product decision, so the ' +
    'violation is recorded here rather than papered over. If this file ever becomes ' +
    'reachable again, the exception must go before it does.',
}

describe('guardrail: every work-order completion path runs the completion side effects', () => {
  it('a file that writes the completion columns also calls finalizeWorkOrderCompletion', () => {
    const offenders: string[] = []

    for (const file of collectSourceFiles(['app'])) {
      const path = rel(file)
      if (path === HELPERS) continue          // the helpers module defines both
      if (path in EXCEPTIONS) continue
      const src = read(file)
      if (!COLUMN_WRITER.test(src) && !RAW_COMPLETION_WRITE.test(src)) continue
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

  it('every EXCEPTIONS entry is still a real violation (prune it once fixed)', () => {
    for (const [path, reason] of Object.entries(EXCEPTIONS)) {
      const file = collectSourceFiles(['app']).find((f) => rel(f) === path)
      expect(file, `EXCEPTIONS lists ${path}, which no longer exists — remove the entry.`).toBeDefined()

      const src = read(file!)
      const stillViolates =
        (COLUMN_WRITER.test(src) || RAW_COMPLETION_WRITE.test(src)) && !SIDE_EFFECT_CALL.test(src)

      expect(
        stillViolates,
        `EXCEPTIONS lists ${path}, which no longer violates the rule — delete the entry so ` +
          `the fix is locked in. Recorded reason was: ${reason}`,
      ).toBe(true)
    }
  })

  // A pattern that matches nothing is indistinguishable from a clean tree, and
  // one that matches everything gets suppressed rather than fixed. Both
  // directions are pinned against fixtures instead of live files, so a real fix
  // upstream cannot silently turn this into a no-op.
  it('RAW_COMPLETION_WRITE fires on a work_orders completion and not on a turnover one', () => {
    const workOrder = `
      await supabase
        .from('work_orders')
        .update({
          public_signed_off_at: now,
          status:               'completed',
        })
        .eq('id', wo.id)
    `
    const turnover = `
      await supabase
        .from('turnovers')
        .update({ status: 'completed', completed_at: completedAt })
        .eq('id', turnover.id)
    `
    // The shape that defeats a file-level "mentions both" check: a work_orders
    // READ and a turnovers completion in one file. This is
    // app/api/work-orders/[token]/complete/helpers.ts, which is correct code.
    const mixed = `
      const { data } = await supabase.from('work_orders').select('id, org_id').eq('id', id)
      await supabase.from('turnovers').update({ status: 'completed' }).eq('id', t.id)
    `

    expect(RAW_COMPLETION_WRITE.test(workOrder)).toBe(true)
    expect(RAW_COMPLETION_WRITE.test(turnover)).toBe(false)
    expect(RAW_COMPLETION_WRITE.test(mixed)).toBe(false)
  })
})
