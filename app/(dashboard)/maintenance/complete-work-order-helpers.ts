import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { reportError } from '@/lib/observability/report-error'
import type { ScheduleFrequency, WoStatus } from '@/types/database'

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
export function workOrderCompletionFields(notes?: string | null): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    status:         'completed' satisfies WoStatus,
    completed_date: isoDate(),
  }
  if (notes !== undefined) fields.completion_notes = notes
  return fields
}

/**
 * Advance every source maintenance schedule behind a batch of completed work
 * orders. The read is batched into one `.in()` query; the writes are
 * necessarily one per schedule because each carries its own computed
 * next_due_date.
 */
async function advanceSchedulesAfterCompletion(
  supabase: SupabaseClient,
  orgId:    string,
  entries:  { scheduleId: string; workOrderSource: string | null }[],
): Promise<void> {
  if (entries.length === 0) return

  const sourceByScheduleId = new Map(entries.map((e) => [e.scheduleId, e.workOrderSource]))
  const scheduleIds        = Array.from(sourceByScheduleId.keys())

  const { data: schedules, error } = await supabase
    .from('maintenance_schedules')
    .select('id, schedule_type, frequency, next_due_date, auto_create_wo')
    .in('id', scheduleIds)
    .eq('org_id', orgId)

  if (error) {
    console.error('[advanceSchedulesAfterCompletion] schedule read failed', error)
    reportError(error, { site: 'maintenance.advanceSchedulesAfterCompletion.read', orgId })
    return
  }

  const lastCompleted = isoDate()

  const writes = (schedules ?? []).map((schedule: {
    id: string; schedule_type: string | null; frequency: string | null; next_due_date: string | null
  }) => {
    if (!schedule.next_due_date) return null

    // Seasonal / one-time: just record the completion date.
    if (schedule.schedule_type !== 'routine' || !schedule.frequency) {
      return supabase
        .from('maintenance_schedules')
        .update({ last_completed_date: lastCompleted })
        .eq('id', schedule.id)
        .eq('org_id', orgId)
    }

    // Bumped (gap-driven) completions anchor to the ACTUAL completion date —
    // anchoring to the original scheduled date would discard the benefit of
    // having done the work early and silently desync the cadence over time.
    // Normal on-time completions keep the existing fixed-calendar anchor.
    const anchor = sourceByScheduleId.get(schedule.id) === 'vacancy_gap_suggestion'
      ? new Date(lastCompleted)
      : new Date(schedule.next_due_date)

    const nextDue = calcNextDueDate(schedule.frequency as ScheduleFrequency, anchor)

    return supabase
      .from('maintenance_schedules')
      .update({
        last_completed_date: lastCompleted,
        next_due_date:       nextDue.toISOString().split('T')[0],
      })
      .eq('id', schedule.id)
      .eq('org_id', orgId)
  }).filter((w): w is NonNullable<typeof w> => w !== null)

  const results = await Promise.all(writes)
  for (const result of results) {
    if (result.error) {
      console.error('[advanceSchedulesAfterCompletion] schedule advance failed', result.error)
      reportError(result.error, { site: 'maintenance.advanceSchedulesAfterCompletion.write', orgId })
    }
  }
}

/**
 * Every side effect a completed work order must carry, for one or many rows.
 *
 * Call this ONLY with rows a completing UPDATE actually returned — that is
 * what keeps a double-submit or a concurrent bulk completion from firing
 * `work-order/completed` twice for the same work order.
 */
export async function finalizeWorkOrderCompletion(
  supabase: SupabaseClient,
  orgId:    string,
  rows:     CompletedWorkOrderRow[],
  options:  FinalizeCompletionOptions = {},
): Promise<void> {
  if (rows.length === 0) return

  // One event per work order so each gets its own Inngest retry path; sent as
  // a single batch so the fan-out is one round-trip, not one per row.
  await inngest.send(
    rows.map((row) => ({
      name: 'work-order/completed' as const,
      data: {
        work_order_id: row.id,
        property_id:   row.property_id,
        org_id:        row.org_id,
        actual_cost:   row.actual_cost ?? row.estimated_cost ?? null,
      },
    }))
  )

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
