import { MAX_TASK_DEPTH, type SettingsTeam, type AutonomyLevel } from './constants'

/**
 * The rules the GTM agents run under, as pure functions.
 *
 * Kept free of Supabase, Inngest and the model SDK on purpose: these are the
 * decisions that matter most (is this team allowed to run, is this task too
 * deep, is the budget spent) and a decision with no I/O is one a test can pin
 * exhaustively. The code that acts on them lives in tasks.ts and the Inngest
 * functions, and is deliberately thin.
 */

export interface TeamSetting {
  team:                 SettingsTeam
  enabled:              boolean
  autonomy:             AutonomyLevel
  daily_task_cap:       number
  daily_cost_cap_cents: number
}

/**
 * A team runs only when its own switch AND the master switch are on.
 *
 * A MISSING row reads as off, not on: if settings could not be loaded, or the
 * seed row is gone, the safe answer to "may this agent act" is no. The inverse
 * default would let an empty table switch every agent on.
 */
export function isTeamRunnable(settings: readonly TeamSetting[], team: SettingsTeam): boolean {
  const global = settings.find((s) => s.team === 'global')
  const own    = settings.find((s) => s.team === team)
  return global?.enabled === true && own?.enabled === true
}

export function settingFor(settings: readonly TeamSetting[], team: SettingsTeam): TeamSetting | undefined {
  return settings.find((s) => s.team === team)
}

/**
 * The depth of a task spawned from `parentDepth`, or null when that would
 * exceed MAX_TASK_DEPTH. A task with no parent (a manager or human request) is
 * depth 0. The database enforces the same ceiling in a CHECK; this exists so a
 * caller learns "too deep" as a decision it can log, not as a constraint
 * violation it has to decode.
 */
export function childDepth(parentDepth: number | null): number | null {
  if (parentDepth === null) return 0
  if (!Number.isInteger(parentDepth) || parentDepth < 0) return null
  const next = parentDepth + 1
  return next > MAX_TASK_DEPTH ? null : next
}

/**
 * Where a finished task goes. A team on propose_only never finishes anything
 * itself, whatever the task says: autonomy is the team-wide ceiling and the
 * per-task flag can only ask for MORE review, never less.
 */
export function finishStatus(input: {
  requiresApproval: boolean
  autonomy:         AutonomyLevel
}): 'needs_approval' | 'done' {
  return input.requiresApproval || input.autonomy === 'propose_only' ? 'needs_approval' : 'done'
}

export type BudgetVerdict = 'ok' | 'task_cap' | 'cost_cap'

/**
 * Whether a team may start another unit of work today.
 *
 * Both ceilings are checked, the cost one first: it is the one that bills.
 * A cap of 0 means "do nothing today" rather than "unlimited": the only way to
 * remove a ceiling is to raise it, never to blank it.
 */
export function budgetVerdict(input: {
  tasksToday:   number
  taskCap:      number
  spentCents:   number
  costCapCents: number
}): BudgetVerdict {
  if (input.spentCents >= input.costCapCents) return 'cost_cap'
  if (input.tasksToday >= input.taskCap) return 'task_cap'
  return 'ok'
}

// ── cost ────────────────────────────────────────────────────────────────────

/** US dollars per million tokens. */
interface ModelRate { input: number; output: number }

/**
 * Published list rates for the models these agents use. An ESTIMATE: it prices
 * the tokens the API reported, and it exists so a daily cap can be enforced
 * without waiting for an invoice. Re-check against the provider's pricing page
 * when a model is added.
 */
const MODEL_RATES: ReadonlyArray<{ prefix: string; rate: ModelRate }> = [
  { prefix: 'claude-haiku',  rate: { input: 1,  output: 5 } },
  { prefix: 'claude-sonnet', rate: { input: 3,  output: 15 } },
  { prefix: 'claude-opus',   rate: { input: 15, output: 75 } },
]

/** A model with no known rate is priced at the dearest one, so a cap errs toward stopping. */
const FALLBACK_RATE: ModelRate = { input: 15, output: 75 }

export function estimateCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const rate = MODEL_RATES.find((r) => model.startsWith(r.prefix))?.rate ?? FALLBACK_RATE
  const dollars = (Math.max(0, inputTokens) * rate.input + Math.max(0, outputTokens) * rate.output) / 1_000_000
  // 4 decimal places of a cent, matching numeric(12,4) in agent_usage.
  return Math.round(dollars * 100 * 10_000) / 10_000
}

// ── the "day" the caps reset on ─────────────────────────────────────────────

const CT_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

function partsOf(now: Date): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of CT_PARTS.formatToParts(now)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return out
}

/**
 * The instant the current Central Time day began. Daily caps reset here, the
 * same clock the other crons are written against. Off by an hour on the two
 * days a year the clocks change, which moves when a cap resets and nothing else.
 */
export function centralDayStart(now: Date): Date {
  const p = partsOf(now)
  const sinceMidnightMs = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + now.getMilliseconds()
  return new Date(now.getTime() - sinceMidnightMs)
}

/** YYYY-MM-DD for the Central Time day containing `now`: the stable half of a per-day dedupe key. */
export function centralDateKey(now: Date): string {
  const p = partsOf(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}
