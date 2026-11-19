/**
 * Shared vocabulary for the GTM agent system (migration
 * 20261118120000_gtm_agent_foundation.sql).
 *
 * Zero imports on purpose: the Agents dashboard is a mix of Server and Client
 * Components and both read these, so this module must be safe in either. Every
 * list here is mirrored by a CHECK constraint, and the CHECK is what actually
 * enforces it. Adding a team or a status means editing both.
 */

/** The four teams that do work. The manager routes their tasks and owns none. */
export const WORKER_TEAMS = ['lead_gen', 'content_brand', 'sales_ops', 'rev_ops'] as const
export type WorkerTeam = (typeof WORKER_TEAMS)[number]

/** Everything with a settings row: the master switch, the manager, and the teams. */
export const SETTINGS_TEAMS = ['global', 'manager', ...WORKER_TEAMS] as const
export type SettingsTeam = (typeof SETTINGS_TEAMS)[number]

/** Everything that can spend model tokens. */
export const USAGE_TEAMS = ['manager', ...WORKER_TEAMS] as const
export type UsageTeam = (typeof USAGE_TEAMS)[number]

export const TEAM_LABELS: Record<SettingsTeam, string> = {
  global:        'Master switch',
  manager:       'Manager',
  lead_gen:      'Lead Gen',
  content_brand: 'Content & Brand',
  sales_ops:     'Sales Ops',
  rev_ops:       'Rev Ops',
}

export const TEAM_BLURBS: Record<SettingsTeam, string> = {
  global:        'Pauses every agent at once. Nothing runs while this is off.',
  manager:       'Plans the day, routes work, watches for stalls and writes the daily brief.',
  lead_gen:      'Finds public contact details and proposes which accounts to queue for outreach.',
  content_brand: 'Outreach copy, sequences and brand-voice checks.',
  sales_ops:     'Drafts follow-up emails and call briefs for you to use yourself. Sends nothing and calls no one.',
  rev_ops:       'Pipeline reporting, data hygiene and funnel conversion.',
}

export const TASK_STATUSES = [
  'pending', 'in_progress', 'needs_approval', 'approved',
  'rejected', 'done', 'failed', 'cancelled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending:        'Queued',
  in_progress:    'Working',
  needs_approval: 'Needs approval',
  approved:       'Approved',
  rejected:       'Rejected',
  done:           'Done',
  failed:         'Failed',
  cancelled:      'Cancelled',
}

/** Work that has not reached an end state: the queue a person would call "open". */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = [
  'pending', 'in_progress', 'needs_approval', 'approved',
]

export const TASK_ORIGINS = ['manager', 'human', ...WORKER_TEAMS] as const
export type TaskOrigin = (typeof TASK_ORIGINS)[number]

export const AUTONOMY_LEVELS = ['propose_only', 'auto_low_risk'] as const
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number]

export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  propose_only:  'Propose only',
  auto_low_risk: 'Auto-finish low risk',
}

export const MANAGER_RUN_KINDS = ['morning_plan', 'evening_review', 'stall_sweep', 'manual'] as const
export type ManagerRunKind = (typeof MANAGER_RUN_KINDS)[number]

export const MANAGER_RUN_LABELS: Record<ManagerRunKind, string> = {
  morning_plan:   'Morning plan',
  evening_review: 'Evening review',
  stall_sweep:    'Stall sweep',
  manual:         'Run on request',
}

/**
 * How many handoffs deep a task may be. Mirrors agent_tasks_depth_check: a
 * team that creates work from work another team created could otherwise do it
 * forever. A manager or human origin is depth 0.
 */
export const MAX_TASK_DEPTH = 4

/**
 * A claimed task that has made no progress for this long is presumed dead and
 * put back in the queue. So a worker must finish within this window or break
 * its job into smaller tasks: one that runs longer is requeued underneath
 * itself, and its completeTask() then finds the task no longer in_progress and
 * reports it was not recorded.
 */
export const IN_PROGRESS_STALL_MINUTES = 30

/** A draft waiting on a person this long is called out in the manager's brief. */
export const APPROVAL_WAIT_WARN_HOURS = 48

/** Bounds on the caps an admin can set, so a typo cannot become an unbounded run. */
export const MAX_DAILY_TASK_CAP = 10_000
export const MAX_DAILY_COST_CAP_CENTS = 100_000

export function isWorkerTeam(value: unknown): value is WorkerTeam {
  return typeof value === 'string' && (WORKER_TEAMS as readonly string[]).includes(value)
}

export function isSettingsTeam(value: unknown): value is SettingsTeam {
  return typeof value === 'string' && (SETTINGS_TEAMS as readonly string[]).includes(value)
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

export function isManagerKind(value: unknown): value is ManagerRunKind {
  return typeof value === 'string' && (MANAGER_RUN_KINDS as readonly string[]).includes(value)
}

export function isAutonomy(value: unknown): value is AutonomyLevel {
  return typeof value === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(value)
}
