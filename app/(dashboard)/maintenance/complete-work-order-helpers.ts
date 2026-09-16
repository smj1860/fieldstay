import 'server-only'
import { fetchAllRows } from '@/lib/inngest/paginate'

import type { SupabaseClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { reportError } from '@/lib/observability/report-error'
import type { ScheduleFrequency, TablesUpdate, WoStatus } from '@/types/database'

/**
 * THE single completion path for a work order.
 *
 * There are three ways a PM can complete a work order — updateWorkOrderStatus
 * (./actions.ts), bulkUpdateWorkOrderStatus (./actions.ts) and markWorkVerified
 * (./work-order-actions.ts, the WO detail "verify" button). Only the first one
 * ever fired `work-order/completed`, which is what posts the maintenance
 * expense to owner_transactions and advances the source maintenance schedule's
 * next_due_date. The other two wrote `status = 'completed'` and nothing else:
 * a month-end bulk completion of ten recurring WOs left the owner P&L short
 * ten expenses and left every source schedule on its old next_due_date, so the
 * nightly cron re-created the same work orders. No error surfaced anywhere.
 *
 * Every completion side effect therefore lives here, and all three call sites
 * go through it:
 *   - `workOrderCompletionFields()` — the column payload (status +
 *     completed_date, and completion_notes when the caller has notes).
 *   - `finalizeWorkOrderCompletion()` — one `work-order/completed` event per
 *     completed row, the `work_order_updates` audit row, and the source
 *     maintenance-schedule advance.
 *
 * A new completion path must call BOTH, and must select
 * `COMPLETED_WORK_ORDER_SELECT` back off its own UPDATE so it fans out only
 * over rows the write actually claimed.
 */

/** Columns `finalizeWorkOrderCompletion` needs off the completing UPDATE. */
export const COMPLETED_WORK_ORDER_SELECT =
  'id, property_id, org_id, source_schedule_id, source, actual_cost, estimated_cost'

export interface CompletedWorkOrderRow {
  id:                 string
  property_id:        string
  org_id:             string
  source_schedule_id: string | null
  source:             string | null
  actual_cost:        number | null
  estimated_cost:     number | null
}

export interface FinalizeCompletionOptions {
  /** Prior status per work order id, for the work_order_updates audit row. */
  statusFromById?:   Map<string, WoStatus | null>
  /** Completion notes, when the completing path collected any. */
  notes?:            string | null
  /** The PM who completed it, when the call site knows. */
  updatedByUserId?:  string | null
}

function isoDate() { return new Date().toISOString().split('T')[0] }

/**
 * The column payload every completion path writes. `completed_date` was
 * missing from the bulk path entirely, which is why it is built here rather
 * than open-coded per call site.
 *
 * `completion_notes` is only included when the caller actually has notes —
 * writing `null` unconditionally would wipe notes an earlier save recorded.
 */
export function workOrderCompletionFields(notes?: string | null): TablesUpdate<'work_orders'> {
  const fields: TablesUpdate<'work_orders'> = {
    status:         'completed' satisfies WoStatus,
    completed_date: isoDate(),
  }
  if (notes !== undefined) fields.completion_notes = notes
  return fields
}

/**
 * Advance every source maintenance schedule behind a batch of completed work
 * orders. Both the read and the write are ONE round trip regardless of batch
 * size — the write is a single set-based UPDATE via the
 * bulk_advance_maintenance_schedules RPC
 * (20260916120000_bulk_advance_maintenance_schedules_rpc.sql), even though
 * each row carries its own computed next_due_date. This used to be one
 * `.update()` per schedule fanned out with Promise.allSettled: fine for a
 * handful of schedules, but a 500-work-order bulk completion fired 500
 * simultaneous UPDATEs at the database in one request — the platform-wide
 * version of the same N+1 shape CLAUDE.md bans in a loop.
 *
 * Exported so the vendor portal completion path
 * (app/api/work-orders/[token]/complete/helpers.ts) can advance its source
 * schedules WITHOUT going through finalizeWorkOrderCompletion. That path
 * deliberately does not fire `work-order/completed` — its expense posts from
 * the Stripe invoice-paid handler instead, and firing both would put two
 * writers on the same owner_transactions row. The schedule advance was the
 * one side effect it was missing, so it is the only one it should borrow.
 */
export async function advanceSchedulesAfterCompletion(
  supabase: SupabaseClient,
  orgId:    string,
  entries:  { scheduleId: string; workOrderSource: string | null }[],
): Promise<void> {
  if (entries.length === 0) return

  const sourceByScheduleId = new Map(entries.map((e) => [e.scheduleId, e.workOrderSource]))
  const scheduleIds        = Array.from(sourceByScheduleId.keys())

  // Paginated: scheduleIds comes from a bulk completion, so the list is sized
  // by the selection rather than by one parent row. fetchAllRows throws on a
  // query error, which the caller's try/catch turns into the same outcome the
  // inline `if (error)` produced — a schedule that silently never advances is
  // a maintenance task that stops recurring.
  let schedules
  try {
    schedules = await fetchAllRows<{
      id: string; schedule_type: string | null; frequency: string | null
      next_due_date: string | null; auto_create_wo: boolean | null
    }>(
      (from, to) => supabase
        .from('maintenance_schedules')
        .select('id, schedule_type, frequency, next_due_date, auto_create_wo')
        .in('id', scheduleIds)
        .eq('org_id', orgId)
        .order('id')
        .range(from, to),
      { label: 'maintenance.advanceSchedulesAfterCompletion.read' },
    )
  } catch (error) {
    console.error('[advanceSchedulesAfterCompletion] schedule read failed', error)
    reportError(error, { site: 'maintenance.advanceSchedulesAfterCompletion.read', orgId })
    return
  }

  const lastCompleted = isoDate()

  interface BulkScheduleUpdate {
    id:                  string
    last_completed_date: string
    next_due_date:       string | null
  }

  const updates: BulkScheduleUpdate[] = (schedules ?? []).map((schedule: {
    id: string; schedule_type: string | null; frequency: string | null
    next_due_date: string | null
  }): BulkScheduleUpdate | null => {
    if (!schedule.next_due_date) return null

    // A non-routine schedule, or one with no frequency: record the completion
    // date only, because there is nothing to derive a next occurrence from.
    // next_due_date is sent as null — the RPC COALESCEs it against the
    // existing stored value rather than overwriting it, so this never
    // clobbers a date with NULL.
    //
    // The seasonal branch that used to sit here is gone with `month_due`
    // (20260823215150). An annually-recurring schedule is `routine` with
    // `frequency = 'annual'` and a next_due_date on the month it recurs in,
    // which the block below already advances correctly — and unlike the
    // seasonal path, that one also advances in the daily cron rather than only
    // on completion.
    if (schedule.schedule_type !== 'routine' || !schedule.frequency) {
      return { id: schedule.id, last_completed_date: lastCompleted, next_due_date: null }
    }

    // Bumped (gap-driven) completions anchor to the ACTUAL completion date —
    // anchoring to the original scheduled date would discard the benefit of
    // having done the work early and silently desync the cadence over time.
    // Normal on-time completions keep the existing fixed-calendar anchor.
    const anchor = sourceByScheduleId.get(schedule.id) === 'vacancy_gap_suggestion'
      ? new Date(lastCompleted)
      : new Date(schedule.next_due_date)

    const nextDue = calcNextDueDate(schedule.frequency as ScheduleFrequency, anchor)

    return {
      id:                  schedule.id,
      last_completed_date: lastCompleted,
      next_due_date:       nextDue.toISOString().split('T')[0]!,
    }
  }).filter((u): u is BulkScheduleUpdate => u !== null)

  if (updates.length === 0) return

  // One set-based UPDATE instead of one .update() call per schedule — see the
  // RPC's own migration comment for why this is safe to run under either an
  // RLS-enforced or a service-role client. This trades the old per-row
  // Promise.allSettled's isolated-failure property (one rejecting write
  // couldn't block the others) for one atomic round trip: either every
  // schedule in this batch advances, or none does, and there is exactly one
  // failure to report instead of up to N of them. That isolation only existed
  // because there used to be hundreds of independent round trips in the first
  // place — collapsing them to one is the actual fix, not a regression in
  // resilience.
  try {
    const { error, data: applied } = await supabase.rpc('bulk_advance_maintenance_schedules', {
      p_org_id:  orgId,
      p_updates: updates,
    })

    if (error) {
      console.error('[advanceSchedulesAfterCompletion] bulk schedule advance failed', error)
      reportError(error, {
        site:  'maintenance.advanceSchedulesAfterCompletion.write',
        orgId,
        extra: { schedules_attempted: updates.length },
      })
    } else if (typeof applied === 'number' && applied < updates.length) {
      // Not an error — some schedules went away (deleted, or an org-mismatch
      // that should never happen given orgId is server-derived) between the
      // read and this write. Worth a warning-level signal rather than silence,
      // same reasoning as persistScores()'s shortfall comment in
      // lib/inngest/functions/cron/asset-health-helpers.ts.
      reportError(new Error('bulk_advance_maintenance_schedules applied fewer rows than requested'), {
        site:  'maintenance.advanceSchedulesAfterCompletion.write',
        orgId,
        level: 'warning',
        extra: { schedules_attempted: updates.length, schedules_applied: applied },
      })
    }
  } catch (error) {
    console.error('[advanceSchedulesAfterCompletion] bulk schedule advance threw', error)
    reportError(error, {
      site:  'maintenance.advanceSchedulesAfterCompletion.write',
      orgId,
      extra: { schedules_attempted: updates.length },
    })
  }
}

/** Attempts, with jittered backoff, before giving up on `inngest.send()`. */
const INNGEST_SEND_ATTEMPTS = 3
const INNGEST_SEND_BASE_DELAY_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Send the `work-order/completed` batch, retrying a transient failure rather
 * than losing the event outright. Safe to retry — and safe if Inngest
 * actually received an earlier attempt this client never got confirmation
 * for — because the downstream handler's `owner_transactions` write is an
 * UPSERT keyed on `source_reference_id` (see handleWorkOrderCompleted),
 * so a duplicate delivery is a no-op, not a double expense.
 *
 * Reports and swallows rather than throwing on final failure: this is called
 * from `finalizeWorkOrderCompletion`, which by design must never let an
 * Inngest outage make the completing UPDATE (already committed by the
 * caller) look like it failed.
 */
async function sendCompletionEventWithRetry(
  rows:  CompletedWorkOrderRow[],
  orgId: string,
): Promise<void> {
  const events = rows.map((row) => ({
    name: 'work-order/completed' as const,
    data: {
      work_order_id: row.id,
      property_id:   row.property_id,
      org_id:        row.org_id,
      actual_cost:   row.actual_cost ?? row.estimated_cost ?? null,
    },
  }))

  for (let attempt = 1; attempt <= INNGEST_SEND_ATTEMPTS; attempt++) {
    try {
      await inngest.send(events)
      return
    } catch (err) {
      if (attempt === INNGEST_SEND_ATTEMPTS) {
        console.error('[finalizeWorkOrderCompletion] inngest.send failed after retries', err)
        reportError(err, {
          site:  'maintenance.finalizeWorkOrderCompletion.send',
          orgId,
          extra: { work_order_ids: rows.map((r) => r.id).join(',') },
        })
        return
      }
      // eslint-disable-next-line no-restricted-properties -- retry jitter to desynchronise concurrent callers, not id/token generation
      const jitter = Math.random() * INNGEST_SEND_BASE_DELAY_MS // NOSONAR -- timing jitter only
      await sleep(INNGEST_SEND_BASE_DELAY_MS * 2 ** (attempt - 1) + jitter)
    }
  }
}

/**
 * Fires the `work-order/completed` batch off the request's critical path.
 *
 * sendCompletionEventWithRetry can sleep up to ~1.4s across its three
 * attempts (jittered exponential backoff), and finalizeWorkOrderCompletion
 * runs inline in the same request that just completed the work order — a
 * plain `await` on it held the HTTP response open for that long on EVERY
 * completion, which at 100x traffic is the request path serializing on a
 * single Inngest send.
 *
 * `after()` (Next's request-lifecycle hook — same pattern as
 * `sendEventAsync` in lib/inngest/client.ts) keeps the serverless invocation
 * alive long enough for the retry loop and its own reportError() call to
 * finish, instead of racing a bare unawaited promise against Vercel freezing
 * the invocation the instant the response is sent — which could silently
 * drop the send before it (or even its first attempt) completes. Every
 * current call site (bulkUpdateWorkOrderStatus, markWorkVerified, the crew
 * completion route) is a Server Action or Route Handler, so `after()` always
 * has a real request to attach to in production.
 *
 * The catch is a defensive fallback only — `after()` throws synchronously
 * when called outside an actual Next.js request scope (verified against the
 * real `next/server` package, not just this codebase's mocks of it). That
 * should never happen given the call sites above, but finalizeWorkOrderCompletion's
 * whole contract is that it never throws, so a future call site (or a test)
 * that isn't request-scoped still gets the event sent — just without the
 * keep-alive guarantee — rather than an uncaught throw undoing that contract.
 */
function scheduleCompletionEventSend(rows: CompletedWorkOrderRow[], orgId: string): void {
  try {
    after(() => sendCompletionEventWithRetry(rows, orgId))
  } catch {
    void sendCompletionEventWithRetry(rows, orgId)
  }
}

/**
 * Every side effect a completed work order must carry, for one or many rows.
 *
 * Call this ONLY with rows a completing UPDATE actually returned — that is
 * what keeps a double-submit or a concurrent bulk completion from firing
 * `work-order/completed` twice for the same work order.
 *
 * Deliberately never throws. The completing UPDATE that produced `rows` has
 * ALREADY committed by the time this runs — it is a separate write, not one
 * transaction with this function — and every call site guards its own UPDATE
 * with `.neq('status', 'completed')` so a retry can never re-claim the row.
 * A side effect that throws out of here used to propagate to the caller's
 * outer try/catch, which reported "Operation failed. Please try again." even
 * though the work order WAS completed — telling the PM to retry an action
 * that can no longer run, while the missed event/audit row/schedule advance
 * stayed lost with nothing to surface it. Every step below is now isolated
 * and self-reporting instead, so one failing step can never suppress or lose
 * visibility into the others.
 */
export async function finalizeWorkOrderCompletion(
  supabase: SupabaseClient,
  orgId:    string,
  rows:     CompletedWorkOrderRow[],
  options:  FinalizeCompletionOptions = {},
): Promise<void> {
  if (rows.length === 0) return

  // One event per work order so each gets its own Inngest retry path; sent as
  // a single batch so the fan-out is one round-trip, not one per row. Fired
  // off the critical path (see scheduleCompletionEventSend) rather than
  // awaited here — the retry loop's sleeps must not hold the HTTP response
  // open on every single completion.
  scheduleCompletionEventSend(rows, orgId)

  const { error: updatesError } = await supabase.from('work_order_updates').insert(
    rows.map((row) => ({
      work_order_id:             row.id,
      org_id:                    orgId,
      updated_by_user_id:        options.updatedByUserId ?? null,
      updated_via_vendor_portal: false,
      status_from:               options.statusFromById?.get(row.id) ?? null,
      status_to:                 'completed' satisfies WoStatus,
      notes:                     options.notes ?? null,
    }))
  )

  if (updatesError) {
    console.error('[finalizeWorkOrderCompletion] work_order_updates insert failed', updatesError)
    reportError(updatesError, { site: 'maintenance.finalizeWorkOrderCompletion.updates', orgId })
  }

  await advanceSchedulesAfterCompletion(
    supabase,
    orgId,
    rows
      .filter((row) => row.source_schedule_id)
      .map((row) => ({ scheduleId: row.source_schedule_id as string, workOrderSource: row.source })),
  )
}
