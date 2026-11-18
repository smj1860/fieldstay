import 'server-only'
import { inngest } from '@/lib/inngest/client'
import { reportError } from '@/lib/observability/report-error'
import { unwrapCount, unwrapList } from '@/lib/supabase/unwrap'
import type { createServiceClient } from '@/lib/supabase/server'
import type { AgentTask } from '@/types/database'
import type { Json } from '@/types/database.generated'
import { isAutonomy, isSettingsTeam, type AutonomyLevel, type TaskOrigin, type WorkerTeam } from './constants'
import {
  budgetVerdict,
  centralDayStart,
  childDepth,
  estimateCostCents,
  finishStatus,
  isTeamRunnable,
  settingFor,
  type TeamSetting,
} from './policy'
import { fetchRollup, spentTodayCents } from './rollup'

/**
 * The queue contract every GTM team and the manager work through.
 *
 * Teams hand work to each other by writing rows here, never by calling each
 * other, so every handoff is visible, replayable and capped. These helpers take
 * a service-role client as an argument rather than creating one: callers make it
 * inside their own step.run(), the only place the codebase allows one.
 *
 * Every function returns a decision rather than throwing for the expected
 * refusals (team off, too deep, over budget, duplicate). Those are the system
 * doing its job, and a caller needs to log them, not retry them.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

/** A JSON object column's value, which is what input and output are. */
export type JsonObject = { [key: string]: Json | undefined }

const SITE = 'gtm.tasks'

export async function loadTeamSettings(supabase: ServiceClient): Promise<TeamSetting[]> {
  const rows = unwrapList(
    await supabase
      .from('gtm_team_settings')
      .select('team, enabled, autonomy, daily_task_cap, daily_cost_cap_cents')
      // Six seeded rows. The limit is a ceiling, not a page size.
      .limit(20),
    { site: `${SITE}.loadTeamSettings` },
  )

  // CHECK constraints keep these inside their unions, but the generated types
  // see plain text. A row that somehow is not one of ours is dropped, and a
  // missing row reads as off (see isTeamRunnable), so the failure is safe.
  const settings: TeamSetting[] = []
  for (const row of rows) {
    if (!isSettingsTeam(row.team) || !isAutonomy(row.autonomy)) continue
    settings.push({
      team:                 row.team,
      enabled:              row.enabled,
      autonomy:             row.autonomy,
      daily_task_cap:       row.daily_task_cap,
      daily_cost_cap_cents: row.daily_cost_cap_cents,
    })
  }
  return settings
}

// ── enqueue ─────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  team:              WorkerTeam
  taskType:          string
  origin:            TaskOrigin
  prospectId?:       string | null
  input?:            JsonObject
  priority?:         number
  /** Defaults to true: the safe answer is the default. */
  requiresApproval?: boolean
  /** The task this one was spawned from, so the depth cap can see the chain. */
  parent?:           { id: string; depth: number } | null
  dedupeKey?:        string | null
  /** Injected so a test can pin the day boundary. */
  now?:              Date
}

export type EnqueueResult =
  | { ok: true;  id: string }
  | { ok: false; reason: 'team_off' | 'too_deep' | 'task_cap' | 'cost_cap' | 'duplicate' }

export async function enqueueTask(
  supabase: ServiceClient,
  input: EnqueueInput,
): Promise<EnqueueResult> {
  const now = input.now ?? new Date()

  const settings = await loadTeamSettings(supabase)
  if (!isTeamRunnable(settings, input.team)) return { ok: false, reason: 'team_off' }

  const depth = childDepth(input.parent?.depth ?? null)
  if (depth === null) return { ok: false, reason: 'too_deep' }

  const budget = await checkBudget(supabase, settings, input.team, now)
  if (budget !== 'ok') return { ok: false, reason: budget }

  const { data, error } = await supabase
    .from('agent_tasks')
    .insert({
      team:              input.team,
      task_type:         input.taskType,
      origin:            input.origin,
      prospect_id:       input.prospectId ?? null,
      input:             input.input ?? {},
      priority:          input.priority ?? 50,
      requires_approval: input.requiresApproval ?? true,
      parent_task_id:    input.parent?.id ?? null,
      depth,
      dedupe_key:        input.dedupeKey ?? null,
    })
    .select('id')
    .single()

  if (error) {
    // 23505 is the dedupe_key unique index: this exact job is already queued.
    if (error.code === '23505') return { ok: false, reason: 'duplicate' }
    reportError(error, { site: `${SITE}.enqueue`, extra: { team: input.team, taskType: input.taskType } })
    throw error
  }

  await announce({
    name: 'gtm/task.created',
    data: {
      task_id:           data.id,
      team:              input.team,
      task_type:         input.taskType,
      prospect_id:       input.prospectId ?? null,
      requires_approval: input.requiresApproval ?? true,
    },
  })

  return { ok: true, id: data.id }
}

/** Whether a team may start another task today, against its own caps. */
export async function checkBudget(
  supabase: ServiceClient,
  settings: readonly TeamSetting[],
  team: WorkerTeam,
  now: Date,
): Promise<'ok' | 'task_cap' | 'cost_cap'> {
  const setting = settingFor(settings, team)
  // No row means no caps were ever set, which reads as "do nothing", not "unlimited".
  if (!setting) return 'task_cap'

  const dayStart = centralDayStart(now)

  const tasksToday = unwrapCount(
    await supabase
      .from('agent_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('team', team)
      .gte('created_at', dayStart.toISOString()),
    { site: `${SITE}.checkBudget.tasks`, extra: { team } },
  )

  const rolled = await fetchRollup(supabase, { touchesSince: dayStart, spendSince: dayStart })
  if (!rolled.ok) {
    // Cannot see the spend, so cannot promise it is under the cap: stop.
    reportError(new Error(rolled.error), { site: `${SITE}.checkBudget.rollup`, extra: { team } })
    return 'cost_cap'
  }

  return budgetVerdict({
    tasksToday,
    taskCap:      setting.daily_task_cap,
    spentCents:   spentTodayCents(rolled.rollup, team),
    costCapCents: setting.daily_cost_cap_cents,
  })
}

// ── claim / finish / fail ───────────────────────────────────────────────────

const CLAIM_ATTEMPTS = 3

/**
 * Takes the team's next pending task, or null when the queue is empty.
 *
 * The claim is the UPDATE, not the SELECT before it: two workers can both see
 * the same pending row, and only the one whose `WHERE status = 'pending'`
 * still matches gets it back. A worker that loses the race looks again rather
 * than reporting an empty queue.
 */
export async function claimNextTask(
  supabase: ServiceClient,
  team: WorkerTeam,
): Promise<AgentTask | null> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const { data: candidate, error: selectError } = await supabase
      .from('agent_tasks')
      .select('id')
      .eq('team', team)
      .eq('status', 'pending')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (selectError) {
      reportError(selectError, { site: `${SITE}.claim.select`, extra: { team } })
      throw selectError
    }
    if (!candidate) return null

    const { data, error } = await supabase
      .from('agent_tasks')
      .update({ status: 'in_progress', claimed_at: new Date().toISOString() })
      .eq('id', candidate.id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle()

    if (error) {
      reportError(error, { site: `${SITE}.claim.update`, extra: { team } })
      throw error
    }
    if (data) return data as AgentTask
  }
  return null
}

/**
 * Records a team's output. Whether it lands in the approval inbox or goes
 * straight to done is decided by finishStatus(), not by the caller, so no team
 * can talk its way past its own autonomy setting.
 */
export async function completeTask(
  supabase: ServiceClient,
  task: Pick<AgentTask, 'id' | 'requires_approval'>,
  output: JsonObject,
  autonomy: AutonomyLevel,
): Promise<{ ok: boolean; status: 'needs_approval' | 'done' }> {
  const status = finishStatus({ requiresApproval: task.requires_approval, autonomy })

  const { data, error } = await supabase
    .from('agent_tasks')
    .update({
      status,
      output,
      error:        null,
      completed_at: status === 'done' ? new Date().toISOString() : null,
    })
    .eq('id', task.id)
    // Only the worker that still holds the claim may finish it. A task the
    // stall sweep already took back must not be resurrected by a slow worker.
    .eq('status', 'in_progress')
    .select('id')
    .maybeSingle()

  if (error) {
    reportError(error, { site: `${SITE}.complete`, extra: { taskId: task.id } })
    throw error
  }
  return { ok: data !== null, status }
}

/**
 * One failed attempt. Back to the queue while attempts remain; failed for good
 * once they are spent, and only then is the failure announced.
 */
export async function failTask(
  supabase: ServiceClient,
  task: Pick<AgentTask, 'id' | 'team' | 'task_type' | 'attempts' | 'max_attempts'>,
  message: string,
): Promise<{ terminal: boolean }> {
  const attempts = task.attempts + 1
  const terminal = attempts >= task.max_attempts

  const { data, error } = await supabase
    .from('agent_tasks')
    .update({
      attempts,
      status:       terminal ? 'failed' : 'pending',
      // The text is the caller's own summary. Truncated so a stack trace cannot bloat the row.
      error:        message.slice(0, 500),
      claimed_at:   null,
      completed_at: terminal ? new Date().toISOString() : null,
    })
    .eq('id', task.id)
    .eq('status', 'in_progress')
    // Optimistic lock: if the sweep already counted this attempt, the numbers
    // no longer match and this write finds nothing to change.
    .eq('attempts', task.attempts)
    .select('id')
    .maybeSingle()

  if (error) {
    reportError(error, { site: `${SITE}.fail`, extra: { taskId: task.id } })
    throw error
  }

  if (data && terminal) {
    await announce({
      name: 'gtm/task.failed',
      data: { task_id: task.id, team: task.team, task_type: task.task_type },
    })
  }
  return { terminal: data !== null && terminal }
}

// ── usage ───────────────────────────────────────────────────────────────────

export interface UsageInput {
  team:         'manager' | WorkerTeam
  taskId?:      string | null
  model:        string
  inputTokens:  number
  outputTokens: number
  /** A retried step must pass the same key so it bills once. */
  dedupeKey?:   string | null
}

/** Writes one spend row. A replayed key is a no-op: the first write already counted. */
export async function recordUsage(supabase: ServiceClient, usage: UsageInput): Promise<void> {
  const { error } = await supabase.from('agent_usage').insert({
    team:          usage.team,
    task_id:       usage.taskId ?? null,
    model:         usage.model,
    input_tokens:  usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_cents:    estimateCostCents(usage.model, usage.inputTokens, usage.outputTokens),
    dedupe_key:    usage.dedupeKey ?? null,
  })
  if (!error || error.code === '23505') return
  // Losing a spend row understates the bill, which is the unsafe direction for a cap.
  reportError(error, { site: `${SITE}.recordUsage`, extra: { team: usage.team } })
  throw error
}

// ── events ──────────────────────────────────────────────────────────────────

type EventPayload = Parameters<typeof inngest.send>[0]

/**
 * The event is a wake-up hint, not the source of truth: a team that misses one
 * still finds the task on its next claim. So a send failure is reported and
 * swallowed, rather than undoing a task that is already safely queued.
 */
async function announce(payload: EventPayload): Promise<void> {
  try {
    await inngest.send(payload)
  } catch (err) {
    reportError(err, { site: `${SITE}.announce`, level: 'warning' })
  }
}
