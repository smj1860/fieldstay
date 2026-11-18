import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reportError } from '@/lib/observability/report-error'
import { unwrapList } from '@/lib/supabase/unwrap'
import type { Database } from '@/types/database'
import type { Json } from '@/types/database.generated'
import { isManagerKind, isTaskStatus, isWorkerTeam, type ManagerRunKind, type TaskStatus, type WorkerTeam } from './constants'
import { centralDayStart, type TeamSetting } from './policy'
import { fetchRollup, type GtmRollup } from './rollup'
import { buildMetrics, type ManagerMetrics } from './manager/brief'
import { loadTeamSettings } from './tasks'

/**
 * Everything the Agents view of the Prospecting Funnel renders, in one load.
 *
 * Runs as the signed-in platform admin, NOT the service role: the tables' RLS
 * policies are what restrict these reads to platform staff, so a regression in
 * who may see them fails closed here instead of being bypassed.
 */

const SITE = 'gtm.dashboard'
const SEVEN_DAYS_MS = 7 * 24 * 3_600_000

/** The inbox shows the oldest first, so the longest-waiting item is never the one cut off. */
export const MAX_APPROVALS_SHOWN = 50
export const MAX_RECENT_TASKS = 20
export const MAX_DECISIONS_SHOWN = 8

export interface ApprovalItem {
  id:         string
  team:       WorkerTeam
  taskType:   string
  company:    string | null
  output:     Json | null
  createdAt:  string
}

export interface RecentTask {
  id:        string
  team:      WorkerTeam
  taskType:  string
  status:    TaskStatus
  company:   string | null
  error:     string | null
  updatedAt: string
}

export interface DecisionItem {
  id:            string
  kind:          ManagerRunKind
  brief:         string
  model:         string | null
  autonomyAtRun: string
  createdAt:     string
}

export interface AgentsDashboardData {
  now:        string
  settings:   TeamSetting[]
  rollup:     GtmRollup
  metrics:    ManagerMetrics
  approvals:  ApprovalItem[]
  recent:     RecentTask[]
  decisions:  DecisionItem[]
}

/** The embedded account, which PostgREST returns as an object or a one-element array. */
function companyOf(embed: unknown): string | null {
  const row = Array.isArray(embed) ? embed[0] : embed
  if (typeof row !== 'object' || row === null) return null
  const company = (row as { company?: unknown }).company
  return typeof company === 'string' ? company : null
}

export async function loadAgentsDashboard(
  supabase: SupabaseClient<Database>,
  now: Date = new Date(),
): Promise<AgentsDashboardData> {
  const [settings, rolled, approvalRows, recentRows, decisionRows] = await Promise.all([
    loadTeamSettings(supabase),
    fetchRollup(supabase, {
      touchesSince: new Date(now.getTime() - SEVEN_DAYS_MS),
      spendSince:   centralDayStart(now),
    }),
    supabase
      .from('agent_tasks')
      .select('id, team, task_type, output, created_at, prospect_accounts(company)')
      .eq('status', 'needs_approval')
      .order('created_at', { ascending: true })
      .limit(MAX_APPROVALS_SHOWN),
    supabase
      .from('agent_tasks')
      .select('id, team, task_type, status, error, updated_at, prospect_accounts(company)')
      .order('updated_at', { ascending: false })
      .limit(MAX_RECENT_TASKS),
    supabase
      .from('manager_decisions')
      .select('id, kind, brief, model, autonomy_at_run, created_at')
      .order('created_at', { ascending: false })
      .limit(MAX_DECISIONS_SHOWN),
  ])

  if (!rolled.ok) {
    // The counts are most of the page; rendering zeros would read as "no accounts".
    reportError(new Error(rolled.error), { site: `${SITE}.rollup` })
    throw new Error('Could not load the agent rollup')
  }

  const approvals = unwrapList(approvalRows, { site: `${SITE}.approvals` }).flatMap((r): ApprovalItem[] =>
    isWorkerTeam(r.team)
      ? [{ id: r.id, team: r.team, taskType: r.task_type, company: companyOf(r.prospect_accounts), output: r.output, createdAt: r.created_at }]
      : [])

  const recent = unwrapList(recentRows, { site: `${SITE}.recent` }).flatMap((r): RecentTask[] =>
    isWorkerTeam(r.team) && isTaskStatus(r.status)
      ? [{ id: r.id, team: r.team, taskType: r.task_type, status: r.status, company: companyOf(r.prospect_accounts), error: r.error, updatedAt: r.updated_at }]
      : [])

  const decisions = unwrapList(decisionRows, { site: `${SITE}.decisions` }).flatMap((r): DecisionItem[] =>
    isManagerKind(r.kind)
      ? [{ id: r.id, kind: r.kind, brief: r.brief, model: r.model, autonomyAtRun: r.autonomy_at_run, createdAt: r.created_at }]
      : [])

  return {
    now:       now.toISOString(),
    settings,
    rollup:    rolled.rollup,
    metrics:   buildMetrics(rolled.rollup, settings, now),
    approvals,
    recent,
    decisions,
  }
}
