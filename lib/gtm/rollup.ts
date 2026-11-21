import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  isSettingsTeam, isTaskStatus, isWorkerTeam, OPEN_TASK_STATUSES,
  type TaskStatus, type UsageTeam, type WorkerTeam,
} from './constants'

/**
 * Everything the Agents dashboard, the manager and the budget check read in
 * one number-crunching round trip: public.gtm_dashboard_counts(), computed in
 * the database so no row crosses the wire.
 *
 * The function returns jsonb, which the Supabase client types as `unknown`
 * (and `.rpc()` is not type-checked against the schema here at all), so this
 * module is the one place the shape is asserted. Anything malformed narrows to
 * an empty value rather than throwing: a dashboard that renders zeros for a
 * field it could not parse is wrong in a visible way, one that 500s hides the
 * rest of the page behind it.
 */

export interface TaskCount { team: WorkerTeam; status: TaskStatus; count: number }
export interface SpendRow  { team: UsageTeam;  cost_cents: number; calls: number }

export interface GtmRollup {
  /** accounts per prospect_accounts.status */
  funnel:  Record<string, number>
  /** touches since the window start, per touch_type */
  touches: Record<string, number>
  tasks:   TaskCount[]
  spend:   SpendRow[]
  /** drafts that have waited on a person longer than APPROVAL_WAIT_WARN_HOURS */
  staleApprovals: number
}

export const EMPTY_ROLLUP: GtmRollup = { funnel: {}, touches: {}, tasks: [], spend: [], staleApprovals: 0 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** PostgREST hands bigint and numeric back as numbers or as numeric strings. */
function toCount(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

function parseCountMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) out[key] = toCount(raw)
  return out
}

function parseTasks(value: unknown): TaskCount[] {
  if (!Array.isArray(value)) return []
  const out: TaskCount[] = []
  for (const row of value) {
    if (!isRecord(row) || !isWorkerTeam(row.team) || !isTaskStatus(row.status)) continue
    out.push({ team: row.team, status: row.status, count: toCount(row.count) })
  }
  return out
}

function parseSpend(value: unknown): SpendRow[] {
  if (!Array.isArray(value)) return []
  const out: SpendRow[] = []
  for (const row of value) {
    if (!isRecord(row) || !isSettingsTeam(row.team) || row.team === 'global') continue
    out.push({ team: row.team, cost_cents: toCount(row.cost_cents), calls: toCount(row.calls) })
  }
  return out
}

export function parseRollup(raw: unknown): GtmRollup {
  if (!isRecord(raw)) return EMPTY_ROLLUP
  return {
    funnel:  parseCountMap(raw.funnel),
    touches: parseCountMap(raw.touches),
    tasks:   parseTasks(raw.tasks),
    spend:   parseSpend(raw.spend),
    staleApprovals: toCount(raw.stale_approvals),
  }
}

/** Cents spent today by one team, from a parsed rollup. */
export function spentTodayCents(rollup: GtmRollup, team: UsageTeam): number {
  return rollup.spend.find((s) => s.team === team)?.cost_cents ?? 0
}

/** How many tasks a team has in a given status, from a parsed rollup. */
export function taskCount(rollup: GtmRollup, team: WorkerTeam, status: TaskStatus): number {
  return rollup.tasks.find((t) => t.team === team && t.status === status)?.count ?? 0
}

/** Open work for a team: everything not yet at an end state. */
export function openTaskCount(rollup: GtmRollup, team: WorkerTeam): number {
  return rollup.tasks
    .filter((t) => t.team === team && OPEN_TASK_STATUSES.includes(t.status))
    .reduce((sum, t) => sum + t.count, 0)
}

/** Any Supabase client: the service role in a cron, the admin's own session on the dashboard. */
type RpcClient = Pick<SupabaseClient<Database>, 'rpc'>

export async function fetchRollup(
  client: RpcClient,
  window: { touchesSince: Date; spendSince: Date },
): Promise<{ ok: true; rollup: GtmRollup } | { ok: false; error: string }> {
  const { data, error } = await client.rpc('gtm_dashboard_counts', {
    p_touches_since: window.touchesSince.toISOString(),
    p_spend_since:   window.spendSince.toISOString(),
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true, rollup: parseRollup(data) }
}
