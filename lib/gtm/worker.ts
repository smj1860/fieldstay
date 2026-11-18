import 'server-only'
import { reportError } from '@/lib/observability/report-error'
import type { createServiceClient } from '@/lib/supabase/server'
import type { AgentTask } from '@/types/database'
import type { WorkerTeam } from './constants'
import { isTeamRunnable, settingFor, centralDayStart, type TeamSetting } from './policy'
import { fetchRollup, spentTodayCents } from './rollup'
import {
  claimNextTask,
  completeTask,
  failTask,
  finishTask,
  loadTeamSettings,
  type ClaimStage,
  type JsonObject,
} from './tasks'

/**
 * The loop body every GTM team runs, so the rules that matter live in one place
 * and a team is only the two things that differ: how to DO a task, and how to
 * CARRY OUT a proposal a person has approved.
 *
 * Order of work: approved proposals first (a person already spent attention on
 * them), then new work. Everything a team hands back goes through a function in
 * tasks.ts that decides where it lands, so no handler can route its own output
 * past the approval inbox.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

export interface TaskContext {
  supabase: ServiceClient
  setting:  TeamSetting
  now:      Date
}

/** What doing a task produced. */
export type WorkOutcome =
  /** Something for a person to look at. Lands in the inbox, or at done on a team allowed to finish low-risk work. */
  | { kind: 'propose'; output: JsonObject }
  /** The honest answer is "nothing to propose". Closed as done: an empty proposal has nothing to approve. */
  | { kind: 'nothing'; output: JsonObject }

export interface TaskHandler {
  /** Do the work. Never write anything a person has not approved; return it as a proposal. */
  run:     (task: AgentTask, ctx: TaskContext) => Promise<WorkOutcome>
  /** Carry out the proposal a person approved. Runs only for a task with a recorded decision. */
  execute: (task: AgentTask, ctx: TaskContext) => Promise<{ output: JsonObject }>
}

export type HandlerRegistry = Record<string, TaskHandler>

export type WorkResult =
  | { worked: false; reason: 'team_off' | 'cost_cap' | 'empty' }
  | { worked: true; stage: ClaimStage; taskType: string; result: 'proposed' | 'nothing' | 'executed' | 'failed' | 'lost_claim' }

/** Whether the team has already spent today's model budget. A team that spends nothing never trips this. */
async function overBudget(supabase: ServiceClient, setting: TeamSetting, team: WorkerTeam, now: Date): Promise<boolean> {
  const rolled = await fetchRollup(supabase, { touchesSince: now, spendSince: centralDayStart(now) })
  // Cannot see the ledger, so cannot promise the cap holds: stop rather than guess.
  if (!rolled.ok) return true
  return spentTodayCents(rolled.rollup, team) >= setting.daily_cost_cap_cents
}

async function claimWork(supabase: ServiceClient, team: WorkerTeam): Promise<{ task: AgentTask; stage: ClaimStage } | null> {
  const approved = await claimNextTask(supabase, team, 'approved')
  if (approved) return { task: approved, stage: 'approved' }
  const pending = await claimNextTask(supabase, team, 'pending')
  return pending ? { task: pending, stage: 'pending' } : null
}

async function settle(
  ctx: TaskContext,
  task: AgentTask,
  stage: ClaimStage,
  handler: TaskHandler,
): Promise<'proposed' | 'nothing' | 'executed' | 'lost_claim'> {
  if (stage === 'approved') {
    const { output } = await handler.execute(task, ctx)
    return (await finishTask(ctx.supabase, task, output)).ok ? 'executed' : 'lost_claim'
  }

  const outcome = await handler.run(task, ctx)
  if (outcome.kind === 'nothing') {
    return (await finishTask(ctx.supabase, task, outcome.output)).ok ? 'nothing' : 'lost_claim'
  }
  const done = await completeTask(ctx.supabase, task, outcome.output, ctx.setting.autonomy)
  return done.ok ? 'proposed' : 'lost_claim'
}

/** Takes one unit of work for `team`, if there is any and the team may run. */
export async function workOne(
  supabase: ServiceClient,
  team: WorkerTeam,
  registry: HandlerRegistry,
  now: Date = new Date(),
): Promise<WorkResult> {
  const settings = await loadTeamSettings(supabase)
  const setting = settingFor(settings, team)
  if (!setting || !isTeamRunnable(settings, team)) return { worked: false, reason: 'team_off' }
  if (await overBudget(supabase, setting, team, now)) return { worked: false, reason: 'cost_cap' }

  const claimed = await claimWork(supabase, team)
  if (!claimed) return { worked: false, reason: 'empty' }
  const { task, stage } = claimed

  const handler = registry[task.task_type]
  if (!handler) {
    // No amount of retrying teaches a team a task type it does not have.
    await failTask(supabase, task, `Unknown task type: ${task.task_type.slice(0, 80)}`, { terminal: true })
    return { worked: true, stage, taskType: task.task_type, result: 'failed' }
  }

  try {
    const result = await settle({ supabase, setting, now }, task, stage, handler)
    return { worked: true, stage, taskType: task.task_type, result }
  } catch (err) {
    reportError(err, { site: `gtm.worker.${team}`, extra: { taskId: task.id, taskType: task.task_type, stage } })
    const message = err instanceof Error ? err.message : 'Unknown error'
    await failTask(supabase, task, message, { resumeTo: stage })
    return { worked: true, stage, taskType: task.task_type, result: 'failed' }
  }
}
