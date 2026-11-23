import 'server-only'
import { unwrapList } from '@/lib/supabase/unwrap'
import type { createServiceClient } from '@/lib/supabase/server'
import type { Json } from '@/types/database.generated'
import { isWorkerTeam, type TaskOrigin, type WorkerTeam } from '../constants'
import { centralDateKey, isTeamRunnable } from '../policy'
import { enqueueTask, loadTeamSettings, type EnqueueResult } from '../tasks'
import { QUEUE_TASK_TYPE } from '../teams/lead-gen-queue'
import { REV_OPS_TASK_TYPES } from '../teams/rev-ops'
import type { ProposedAction } from './instructions'

/**
 * Carries out ONE catalog action, whether a person approved it or the manager is
 * repeating it under a standing permission. This is the only place an
 * instruction becomes work, so it is also where the limits live:
 *
 *   - It writes the task queue and nothing else. It never touches a prospect,
 *     sends nothing and imports no sender (unit/guardrails/gtm-agent-boundaries
 *     holds it to that).
 *   - Every task it creates goes through enqueueTask(), so the team switch, the
 *     daily caps and the depth ceiling all apply exactly as they do to anything
 *     else, and every task is created with requiresApproval = true. A manager
 *     acting alone still hands a person something to read before anything moves.
 *   - A failed task is put back with an UPDATE that carries its own precondition
 *     (`status = 'failed'`), so a task something else already handled is left alone.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

const SITE = 'gtm.manager.apply'

/** How far back a failure is still worth another try, and how many one run puts back. */
export const REQUEUE_WINDOW_DAYS = 7
export const MAX_REQUEUE_PER_RUN = 25
const DAY_MS = 86_400_000

export interface ApplyContext {
  now:    Date
  /** Who asked: a person's approval, or the manager under a standing permission. */
  origin: Extract<TaskOrigin, 'manager'>
}

export interface ActionOutcome {
  kind:    ProposedAction['kind']
  ok:      boolean
  /** One sentence a person reads in the history. Counts only: no account names, no emails. */
  summary: string
}

const REFUSALS: Record<Exclude<EnqueueResult, { ok: true }>['reason'], string> = {
  team_off:  'That team is switched off, so nothing was queued.',
  too_deep:  'That would be too many handoffs deep, so nothing was queued.',
  task_cap:  'That team has reached its task limit for today, so nothing was queued.',
  cost_cap:  'That team has reached its spend limit for today, so nothing was queued.',
  duplicate: 'That was already queued today, so nothing new was added.',
}

function queued(kind: ProposedAction['kind'], result: EnqueueResult, doneText: string): ActionOutcome {
  return result.ok
    ? { kind, ok: true, summary: doneText }
    // A duplicate is the system doing its job, not a failure of the instruction.
    : { kind, ok: result.reason === 'duplicate', summary: REFUSALS[result.reason] }
}

async function runReport(supabase: ServiceClient, ctx: ApplyContext): Promise<ActionOutcome> {
  const result = await enqueueTask(supabase, {
    team:             'rev_ops',
    taskType:         REV_OPS_TASK_TYPES.weeklyFunnelReport,
    origin:           ctx.origin,
    priority:         50,
    requiresApproval: true,
    dedupeKey:        `rev_ops:${REV_OPS_TASK_TYPES.weeklyFunnelReport}:manager:${centralDateKey(ctx.now)}`,
    now:              ctx.now,
  })
  return queued('run_funnel_report', result, 'Asked Rev Ops for a funnel report. It will wait for your approval.')
}

async function runQueueProposal(supabase: ServiceClient, ctx: ApplyContext): Promise<ActionOutcome> {
  const result = await enqueueTask(supabase, {
    team:             'lead_gen',
    taskType:         QUEUE_TASK_TYPE,
    origin:           ctx.origin,
    priority:         60,
    requiresApproval: true,
    dedupeKey:        `lead_gen:${QUEUE_TASK_TYPE}:manager:${centralDateKey(ctx.now)}`,
    now:              ctx.now,
  })
  return queued('propose_queue_candidates', result, 'Asked Lead Gen to propose accounts to queue. The list will wait for your approval.')
}

interface FailedRow { id: string; team: string }

async function requeueFailed(supabase: ServiceClient, ctx: ApplyContext, team: WorkerTeam | undefined): Promise<ActionOutcome> {
  const settings = await loadTeamSettings(supabase)
  const since = new Date(ctx.now.getTime() - REQUEUE_WINDOW_DAYS * DAY_MS).toISOString()

  let find = supabase
    .from('agent_tasks')
    .select('id, team')
    .eq('status', 'failed')
    .gte('updated_at', since)
    .order('updated_at', { ascending: true })
    .limit(MAX_REQUEUE_PER_RUN)
  if (team) find = find.eq('team', team)

  const rows = unwrapList<FailedRow>(await find, { site: `${SITE}.requeue.find` })
  // A task put back for a team that is switched off would just sit there, and
  // the count below would claim it was retried. Leave those failed.
  const ids = rows.filter((r) => isWorkerTeam(r.team) && isTeamRunnable(settings, r.team)).map((r) => r.id)
  if (ids.length === 0) {
    return { kind: 'requeue_failed', ok: true, summary: 'No failed tasks needed another try.' }
  }

  const { data, error } = await supabase
    .from('agent_tasks')
    .update({ status: 'pending', attempts: 0, error: null, claimed_at: null, completed_at: null })
    .in('id', ids)
    .eq('status', 'failed')
    .select('id')
  if (error) throw error

  const count = data?.length ?? 0
  return { kind: 'requeue_failed', ok: true, summary: `Put ${count} failed ${count === 1 ? 'task' : 'tasks'} back in the queue for another try.` }
}

export async function applyAction(supabase: ServiceClient, action: ProposedAction, ctx: ApplyContext): Promise<ActionOutcome> {
  switch (action.kind) {
    case 'run_funnel_report':         return runReport(supabase, ctx)
    case 'propose_queue_candidates':  return runQueueProposal(supabase, ctx)
    case 'requeue_failed':            return requeueFailed(supabase, ctx, action.params.team)
  }
}

/** The outcomes as the JSON column stores them. */
export function outcomesJson(outcomes: readonly ActionOutcome[]): Json {
  return outcomes.map((o) => ({ kind: o.kind, ok: o.ok, summary: o.summary }))
}
