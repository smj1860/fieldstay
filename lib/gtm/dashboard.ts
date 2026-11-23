import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reportError } from '@/lib/observability/report-error'
import { unwrapCount, unwrapList } from '@/lib/supabase/unwrap'
import type { Database } from '@/types/database'
import type { Json } from '@/types/database.generated'
import { isManagerKind, isTaskStatus, isWorkerTeam, type ManagerRunKind, type TaskStatus, type WorkerTeam } from './constants'
import { centralDayStart, type TeamSetting } from './policy'
import { fetchRollup, type GtmRollup } from './rollup'
import { buildMetrics, type ManagerMetrics } from './manager/brief'
import {
  ACTION_CATALOG,
  ACTION_KINDS,
  INSTRUCTION_HISTORY_LIMIT,
  cadenceDaysFor,
  lastActivityAt,
  learnFromHistory,
  mayOfferStanding,
  readStoredProposal,
  recordsFromRows,
  type ActionKind,
  type InstructionHistoryRow,
  type ProposedAction,
} from './manager/instructions'
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

/** One reply to a brief, or one standing run, as the Manager panel shows it. */
export interface InstructionItem {
  id:          string
  source:      'human' | 'standing'
  instruction: string
  status:      string
  reply:       string | null
  proposal:    ProposedAction[]
  /** what carrying it out did, one sentence per action */
  outcomes:    string[]
  createdAt:   string
}

/** One instruction type: what the manager has learned about it and whether it may repeat it alone. */
export interface PlaybookItem {
  kind:           ActionKind
  label:          string
  description:    string
  standing:       boolean
  approved:       number
  rejected:       number
  cadenceDays:    number
  /** the manager would like to take this over: enough approvals, no rejections, not yet granted */
  offered:        boolean
  lastRunAt:      string | null
}

export interface ReadyDraft {
  id:          string
  company:     string | null
  contactName: string | null
  email:       string | null
  subject:     string
  body:        string
  approvedAt:  string | null
}

export interface ReadyCall {
  id:          string
  company:     string | null
  contactName: string | null
  phone:       string | null
  headline:    string
  brief:       string
  approvedAt:  string | null
}

/** How the drafts have been received, the evidence for whether sending could ever be trusted. */
export interface DraftQuality {
  /** drafts a person approved in the window, sent or not yet */
  approved: number
  rejected: number
  /** approved drafts the person has since marked as sent */
  sent:     number
  /** the founder's own words on drafts they rejected, newest first */
  notes:    { note: string; decidedAt: string }[]
}

export const DRAFT_QUALITY_WINDOW_DAYS = 30
export const MAX_READY_DRAFTS = 25
export const MAX_READY_CALLS = 25
export const MAX_QUALITY_NOTES = 5
export const MAX_INSTRUCTIONS_SHOWN = 15

export interface AgentsDashboardData {
  now:        string
  settings:   TeamSetting[]
  rollup:     GtmRollup
  metrics:    ManagerMetrics
  approvals:  ApprovalItem[]
  recent:     RecentTask[]
  decisions:  DecisionItem[]
  instructions: InstructionItem[]
  playbook:   PlaybookItem[]
  readyDrafts:  ReadyDraft[]
  readyCalls:   ReadyCall[]
  draftQuality: DraftQuality
}

/** The embedded account, which PostgREST returns as an object or a one-element array. */
function companyOf(embed: unknown): string | null {
  const row = Array.isArray(embed) ? embed[0] : embed
  if (typeof row !== 'object' || row === null) return null
  const company = (row as { company?: unknown }).company
  return typeof company === 'string' ? company : null
}

function embedFields(embed: unknown): { company: string | null; email: string | null; contactName: string | null; phone: string | null } {
  const row = Array.isArray(embed) ? embed[0] : embed
  const read = (key: string): string | null => {
    const value = typeof row === 'object' && row !== null ? (row as Record<string, unknown>)[key] : null
    return typeof value === 'string' ? value : null
  }
  return { company: read('company'), email: read('email'), contactName: read('contact_name'), phone: read('phone') }
}

/** subject and body out of a stored draft, or null when the output is not one. */
function draftText(output: Json | null): { subject: string; body: string } | null {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return null
  const { subject, body } = output
  return typeof subject === 'string' && typeof body === 'string' ? { subject, body } : null
}

export async function loadDraftReadiness(supabase: SupabaseClient<Database>, now: Date) {
  const since = new Date(now.getTime() - DRAFT_QUALITY_WINDOW_DAYS * 86_400_000).toISOString()
  const drafts = () => supabase.from('agent_tasks').select('id', { count: 'exact', head: true })
    .eq('team', 'sales_ops').eq('task_type', 'draft_outreach').gte('decided_at', since)

  const [ready, approved, sent, rejected, notes] = await Promise.all([
    supabase.from('agent_tasks')
      .select('id, output, decided_at, prospect_accounts(company, email, contact_name)')
      .eq('team', 'sales_ops').eq('task_type', 'draft_outreach').eq('status', 'approved')
      .order('decided_at', { ascending: true })
      .limit(MAX_READY_DRAFTS),
    drafts().in('status', ['approved', 'done']),
    drafts().eq('status', 'done'),
    drafts().eq('status', 'rejected'),
    supabase.from('agent_tasks')
      .select('decision_note, decided_at')
      .eq('team', 'sales_ops').eq('task_type', 'draft_outreach').eq('status', 'rejected')
      .not('decision_note', 'is', null)
      .order('decided_at', { ascending: false })
      .limit(MAX_QUALITY_NOTES),
  ])

  const readyDrafts = unwrapList(ready, { site: `${SITE}.readyDrafts` }).flatMap((r): ReadyDraft[] => {
    const text = draftText(r.output)
    if (!text) return []
    const { company, email, contactName } = embedFields(r.prospect_accounts)
    return [{ id: r.id, company, email, contactName, ...text, approvedAt: r.decided_at }]
  })

  const draftQuality: DraftQuality = {
    approved: unwrapCount(approved, { site: `${SITE}.quality.approved` }),
    sent:     unwrapCount(sent, { site: `${SITE}.quality.sent` }),
    rejected: unwrapCount(rejected, { site: `${SITE}.quality.rejected` }),
    notes:    unwrapList(notes, { site: `${SITE}.quality.notes` }).flatMap((n) =>
      n.decision_note && n.decided_at ? [{ note: n.decision_note, decidedAt: n.decided_at }] : []),
  }
  return { readyDrafts, draftQuality }
}

/** Approved call briefs a person has not yet used. */
export async function loadReadyCalls(supabase: SupabaseClient<Database>): Promise<ReadyCall[]> {
  const res = await supabase.from('agent_tasks')
    .select('id, output, decided_at, prospect_accounts(company, contact_name, phone)')
    .eq('team', 'sales_ops').eq('task_type', 'call_brief').eq('status', 'approved')
    .order('decided_at', { ascending: true })
    .limit(MAX_READY_CALLS)

  return unwrapList(res, { site: `${SITE}.readyCalls` }).flatMap((r): ReadyCall[] => {
    const text = draftText(r.output)
    if (!text) return []
    const { company, contactName, phone } = embedFields(r.prospect_accounts)
    return [{ id: r.id, company, contactName, phone, headline: text.subject, brief: text.body, approvedAt: r.decided_at }]
  })
}

function outcomeSummaries(result: Json | null): string[] {
  if (!Array.isArray(result)) return []
  return result.flatMap((r) => {
    const summary = typeof r === 'object' && r !== null && !Array.isArray(r) ? r.summary : null
    return typeof summary === 'string' ? [summary] : []
  })
}

interface PlaybookRow { action_kind: string; standing: boolean; last_standing_run_at: string | null }

async function loadInstructions(supabase: SupabaseClient<Database>): Promise<{
  instructions: InstructionItem[]
  playbook:     PlaybookItem[]
}> {
  const [recentRes, historyRes, playbookRes] = await Promise.all([
    supabase.from('manager_instructions')
      .select('id, source, instruction, status, reply, proposal, result, created_at')
      .order('created_at', { ascending: false })
      .limit(MAX_INSTRUCTIONS_SHOWN),
    supabase.from('manager_instructions')
      .select('source, status, action_kinds, decided_at')
      .eq('source', 'human')
      .order('created_at', { ascending: false })
      .limit(INSTRUCTION_HISTORY_LIMIT),
    supabase.from('manager_playbook')
      .select('action_kind, standing, last_standing_run_at')
      .limit(ACTION_KINDS.length),
  ])

  const instructions = unwrapList(recentRes, { site: `${SITE}.instructions` }).flatMap((r): InstructionItem[] =>
    r.source === 'human' || r.source === 'standing'
      ? [{
          id: r.id, source: r.source, instruction: r.instruction, status: r.status, reply: r.reply,
          proposal: readStoredProposal(r.proposal), outcomes: outcomeSummaries(r.result), createdAt: r.created_at,
        }]
      : [])

  const history = unwrapList<InstructionHistoryRow>(historyRes, { site: `${SITE}.instructionHistory` })
  const learned = learnFromHistory(recordsFromRows(history))
  const rows = unwrapList<PlaybookRow>(playbookRes, { site: `${SITE}.playbook` })

  const playbook = learned.map((l): PlaybookItem => {
    const row = rows.find((p) => p.action_kind === l.kind)
    const standing = row?.standing === true
    return {
      kind:        l.kind,
      label:       ACTION_CATALOG[l.kind].label,
      description: ACTION_CATALOG[l.kind].description,
      standing,
      approved:    l.approved,
      rejected:    l.rejected,
      cadenceDays: cadenceDaysFor(l),
      offered:     !standing && mayOfferStanding(l),
      lastRunAt:   lastActivityAt(l, row?.last_standing_run_at ?? null),
    }
  })
  return { instructions, playbook }
}

export async function loadAgentsDashboard(
  supabase: SupabaseClient<Database>,
  now: Date = new Date(),
): Promise<AgentsDashboardData> {
  const [settings, rolled, approvalRows, recentRows, decisionRows, readiness, readyCalls, instructionData] = await Promise.all([
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
    loadDraftReadiness(supabase, now),
    loadReadyCalls(supabase),
    loadInstructions(supabase),
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
    instructions: instructionData.instructions,
    playbook:     instructionData.playbook,
    readyDrafts:  readiness.readyDrafts,
    readyCalls,
    draftQuality: readiness.draftQuality,
  }
}
