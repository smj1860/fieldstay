import type { WoStatus, PriorityLevel } from '@/types/database'
import { blocksOnPm, type VendorProgress } from '@/lib/work-orders/vendor-progress'

/**
 * Where an open work order sits in the workflow, and the order a PM should see
 * them in.
 *
 * THE ORGANISING IDEA: the board is a to-do list, so the top of it belongs to
 * the work that is waiting on the PM. Everything else is waiting on somebody
 * else, and its only useful ordering is how far along it is.
 *
 * That gives two tiers rather than one flat lifecycle sequence:
 *
 *   Tier 1, the PM is the blocker. Nothing moves until they decide.
 *     1. quote_approval  a vendor priced the job and is waiting on a yes
 *     2. vendor_blocked   the vendor is stopped at the property and only the
 *                         PM can unstick them (awaiting_access,
 *                         hold_pm_approval)
 *     3. unassigned       nobody has been sent
 *
 *   Tier 2, somebody else holds it. Ordered by progress through the job.
 *     4. awaiting_quote   RFQ out, no quote back yet
 *     5. dispatched       sent to a vendor who has not answered
 *     6. scheduled        the vendor accepted and named a date
 *     7. in_progress      on the way, on site, parts ordered, repairing
 *     8. closing          completed or cancelled, if shown at all
 *
 * `quote_approval` leads deliberately and is not merely one PM-blocking stage
 * among several: it is the only one where a vendor is actively waiting on a
 * reply, so delay there costs the PM a price and sometimes the vendor. A
 * work order with nobody assigned is idle; a submitted quote is perishable.
 *
 * Pure over its inputs, with no Supabase client, so a `'use client'` board can
 * sort with it and a server component can order with the same ladder.
 */

export type WorkflowStage =
  | 'quote_approval'
  | 'vendor_blocked'
  | 'unassigned'
  | 'awaiting_quote'
  | 'dispatched'
  | 'scheduled'
  | 'in_progress'
  | 'closing'

/** Lower sorts first. */
const STAGE_RANK: Record<WorkflowStage, number> = {
  quote_approval: 0,
  vendor_blocked: 1,
  unassigned:     2,
  awaiting_quote: 3,
  dispatched:     4,
  scheduled:      5,
  in_progress:    6,
  closing:        7,
}

export const WORKFLOW_STAGES: readonly WorkflowStage[] =
  (Object.keys(STAGE_RANK) as WorkflowStage[]).sort((a, b) => STAGE_RANK[a] - STAGE_RANK[b])

/** Short labels, for a group heading. No em dash, per the styling rule. */
const STAGE_LABELS: Record<WorkflowStage, string> = {
  quote_approval: 'Quote needs your approval',
  vendor_blocked: 'Vendor is waiting on you',
  unassigned:     'Not assigned yet',
  awaiting_quote: 'Waiting on quotes',
  dispatched:     'Sent, no response yet',
  scheduled:      'Scheduled',
  in_progress:    'In progress',
  closing:        'Closed',
}

export function workflowStageLabel(stage: WorkflowStage): string {
  return STAGE_LABELS[stage]
}

/** True for the tier the PM has to act on. Drives the board's section accent. */
export function stageNeedsPmAction(stage: WorkflowStage): boolean {
  return stage === 'quote_approval' || stage === 'vendor_blocked' || stage === 'unassigned'
}

/** The fields the ladder reads. Callers may pass wider rows. */
export interface StageInput {
  status:              WoStatus
  vendor_id:           string | null
  assigned_crew_member_id?: string | null
  vendor_progress?:    VendorProgress | string | null
  vendor_scheduled_at?: string | null
  /**
   * Whether a vendor has submitted a quote that nobody has approved or
   * declined yet. Supplied by the caller, because it lives in
   * `quote_requests` rather than on the work order.
   *
   * Defaults to FALSE rather than being required: the board's offline Dexie
   * cache has no quote rows, and a missing signal must degrade to "not
   * hoisted" rather than crashing the only view a PM has while offline.
   */
  hasQuoteAwaitingApproval?: boolean
}

export function workflowStage(wo: StageInput): WorkflowStage {
  if (wo.status === 'completed' || wo.status === 'cancelled') return 'closing'

  // Before anything else, including before the status: a vendor's submitted
  // quote outranks whatever lifecycle state the work order is nominally in.
  if (wo.hasQuoteAwaitingApproval) return 'quote_approval'

  const progress = wo.vendor_progress as VendorProgress | null | undefined
  if (progress && blocksOnPm(progress)) return 'vendor_blocked'

  if (wo.status === 'quote_requested') return 'awaiting_quote'

  // Crew-assigned work counts as assigned. It has no vendor and never will, so
  // judging it by vendor_id alone would park every crew work order in
  // "unassigned" forever.
  const hasAssignee = Boolean(wo.vendor_id) || Boolean(wo.assigned_crew_member_id)
  if (!hasAssignee) return 'unassigned'

  if (progress === 'appointment_scheduled') return 'scheduled'
  if (progress) return 'in_progress'

  // Assigned with no vendor response. An appointment with no progress value
  // can only come from a PM setting the date by hand, which is still a
  // commitment, so it reads as scheduled rather than as silence.
  if (wo.vendor_scheduled_at) return 'scheduled'
  if (wo.status === 'in_progress') return 'in_progress'
  return 'dispatched'
}

const PRIORITY_RANK: Record<PriorityLevel, number> = {
  urgent: 0, high: 1, medium: 2, low: 3,
}

export interface SortableWorkOrder extends StageInput {
  priority:        PriorityLevel
  needed_by_date?: string | null
  created_at?:     string
  id:              string
}

/**
 * The board's comparator: stage, then urgency, then the nearest deadline.
 *
 * WHY THIS SECONDARY ORDER. Within one stage every item needs the same next
 * action, so what distinguishes them is how much it costs to be late. Priority
 * is the PM's own marking, and the deadline is the fact; an undated work order
 * sorts AFTER every dated one rather than before, because "no deadline" is not
 * the most urgent thing on the list.
 *
 * `id` last, so the order is total. `created_at` is not unique here (a cron
 * that opens one work order per due schedule writes a whole batch inside the
 * same millisecond), and a comparator that returns 0 for distinct rows lets
 * them swap places between renders.
 */
export function compareWorkflowOrder(a: SortableWorkOrder, b: SortableWorkOrder): number {
  const stage = STAGE_RANK[workflowStage(a)] - STAGE_RANK[workflowStage(b)]
  if (stage !== 0) return stage

  const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (priority !== 0) return priority

  const byDeadline = compareNullableDateAsc(a.needed_by_date, b.needed_by_date)
  if (byDeadline !== 0) return byDeadline

  // Newest first among otherwise equal work, matching the order the board
  // shipped with before stages existed.
  const byCreated = (b.created_at ?? '').localeCompare(a.created_at ?? '')
  if (byCreated !== 0) return byCreated

  return a.id.localeCompare(b.id)
}

/** Ascending, with null LAST. */
function compareNullableDateAsc(a: string | null | undefined, b: string | null | undefined): number {
  if (a && b) return a.localeCompare(b)
  if (a) return -1
  if (b) return 1
  return 0
}

/**
 * Groups work orders into stage sections, in ladder order, dropping empties.
 *
 * Dropping empties is what makes "listed first when they exist" true without a
 * heading for a stage nothing is in: a PM should not scan past an empty "Quote
 * needs your approval" band to reach their actual work.
 */
export function groupByWorkflowStage<T extends SortableWorkOrder>(
  workOrders: readonly T[],
): { stage: WorkflowStage; label: string; workOrders: T[] }[] {
  const byStage = new Map<WorkflowStage, T[]>()

  for (const wo of workOrders) {
    const stage = workflowStage(wo)
    const bucket = byStage.get(stage)
    if (bucket) bucket.push(wo)
    else byStage.set(stage, [wo])
  }

  return WORKFLOW_STAGES.flatMap((stage) => {
    const group = byStage.get(stage)
    if (!group?.length) return []
    return [{
      stage,
      label:      STAGE_LABELS[stage],
      workOrders: [...group].sort(compareWorkflowOrder),
    }]
  })
}
