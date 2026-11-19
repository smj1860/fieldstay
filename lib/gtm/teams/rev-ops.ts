import 'server-only'
import { unwrapCount, unwrapList } from '@/lib/supabase/unwrap'
import type { createServiceClient } from '@/lib/supabase/server'
import type { AgentTask } from '@/types/database'
import type { Json } from '@/types/database.generated'
import { centralDayStart } from '../policy'
import { fetchRollup, spentTodayCents } from '../rollup'
import { enqueueTask, type JsonObject } from '../tasks'
import { DRAFTABLE_STAGES } from './sales-ops-eligibility'
import type { HandlerRegistry, TaskContext, TaskHandler } from '../worker'
import {
  ACTIVE_OUTREACH_STAGES,
  MAX_LEAD_GEN_HANDOFFS,
  MAX_SALES_OPS_HANDOFFS,
  STALE_TOUCH_DAYS,
  buildWeeklyReport,
  priorWeekTouches,
  type ReportInput,
  type StaleExample,
} from './rev-ops-report'

/**
 * Rev Ops: reads the pipeline and writes it up. It changes nothing about any
 * account. Its one act on other teams is a handoff, and that happens only after
 * a person approves the report (see executeReport).
 */

type ServiceClient = ReturnType<typeof createServiceClient>

export const REV_OPS_TASK_TYPES = { weeklyFunnelReport: 'weekly_funnel_report' } as const

const SITE = 'gtm.rev-ops'
const DAY_MS = 86_400_000
const STALE_EXAMPLES_SHOWN = 5
/** Candidates read before filtering out accounts already asked about. Bounded: the filter needs a short, known list. */
const CANDIDATE_POOL = 50
/** An account Lead Gen already looked at is not asked about again for this long. */
const ENRICH_RECHECK_DAYS = 30
/** An account Sales Ops already drafted for is not offered again for this long. Also the length of one dedupe period. */
const DRAFT_RECHECK_DAYS = 14

function daysBetween(from: string | null, now: Date): number | null {
  if (!from) return null
  return Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / DAY_MS))
}

interface StaleRow { company: string; status: string; last_touch_at: string | null }

async function loadStale(supabase: ServiceClient, now: Date): Promise<{ count: number; examples: StaleExample[] }> {
  const cutoff = new Date(now.getTime() - STALE_TOUCH_DAYS * DAY_MS).toISOString()
  const staleFilter = `last_touch_at.lt.${cutoff},last_touch_at.is.null`

  const [count, rows] = await Promise.all([
    supabase.from('prospect_accounts').select('id', { count: 'exact', head: true })
      .in('status', [...ACTIVE_OUTREACH_STAGES]).or(staleFilter),
    supabase.from('prospect_accounts').select('company, status, last_touch_at')
      .in('status', [...ACTIVE_OUTREACH_STAGES]).or(staleFilter)
      .order('last_touch_at', { ascending: true, nullsFirst: true })
      .limit(STALE_EXAMPLES_SHOWN),
  ])

  return {
    count: unwrapCount(count, { site: `${SITE}.stale.count` }),
    examples: unwrapList<StaleRow>(rows, { site: `${SITE}.stale.examples` })
      .map((r) => ({ company: r.company, status: r.status, daysSinceTouch: daysBetween(r.last_touch_at, now) })),
  }
}

async function loadHygiene(supabase: ServiceClient) {
  const [needs, bounced, noChannel] = await Promise.all([
    supabase.from('prospect_accounts').select('id', { count: 'exact', head: true }).eq('status', 'needs_contact_info'),
    supabase.from('prospect_accounts').select('id', { count: 'exact', head: true }).eq('email_status', 'bounced'),
    supabase.from('prospect_accounts').select('id', { count: 'exact', head: true })
      .eq('status', 'queued').is('email', null).is('phone', null),
  ])
  return {
    needsContactInfo: unwrapCount(needs, { site: `${SITE}.hygiene.needs` }),
    bouncedPrimary:   unwrapCount(bounced, { site: `${SITE}.hygiene.bounced` }),
    queuedNoChannel:  unwrapCount(noChannel, { site: `${SITE}.hygiene.noChannel` }),
  }
}

/**
 * Accounts worth asking Lead Gen about: still early in the funnel, no email on
 * file, and a site to read. Best-scored first. Anything Lead Gen already looked
 * at in the last ENRICH_RECHECK_DAYS is dropped, or the same ten accounts would
 * be offered every week and the cap would never reach the next ones.
 */
async function loadEnrichCandidates(supabase: ServiceClient, now: Date): Promise<string[]> {
  const poolRes = await supabase.from('prospect_accounts').select('id')
    .in('status', ['new', 'researching', 'needs_contact_info'])
    .is('email', null)
    .or('website.not.is.null,domain.not.is.null')
    .order('score_a', { ascending: false, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(CANDIDATE_POOL)
  const pool = unwrapList<{ id: string }>(poolRes, { site: `${SITE}.candidates.pool` })
  if (pool.length === 0) return []

  const since = new Date(now.getTime() - ENRICH_RECHECK_DAYS * DAY_MS).toISOString()
  const askedRes = await supabase.from('agent_tasks').select('prospect_id')
    .eq('task_type', 'enrich_account')
    .in('prospect_id', pool.map((p) => p.id))
    .gte('created_at', since)
    .limit(CANDIDATE_POOL)
  const asked = unwrapList<{ prospect_id: string | null }>(askedRes, { site: `${SITE}.candidates.asked` })
  const skip = new Set(asked.map((a) => a.prospect_id))
  return pool.map((p) => p.id).filter((id) => !skip.has(id)).slice(0, MAX_LEAD_GEN_HANDOFFS)
}

/**
 * Accounts worth drafting a follow-up for: still waiting on a first answer, with
 * an email that has not bounced, and not touched in the last STALE_TOUCH_DAYS.
 * Best-scored first. Anything Sales Ops drafted for recently is dropped, or the
 * same few accounts would be offered every week and the rest would never be reached.
 */
async function loadDraftCandidates(supabase: ServiceClient, now: Date): Promise<string[]> {
  const cutoff = new Date(now.getTime() - STALE_TOUCH_DAYS * DAY_MS).toISOString()
  const poolRes = await supabase.from('prospect_accounts').select('id')
    .in('status', [...DRAFTABLE_STAGES])
    .not('email', 'is', null)
    .neq('email_status', 'bounced')
    .or(`last_touch_at.is.null,last_touch_at.lt.${cutoff}`)
    .order('score_a', { ascending: false, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(CANDIDATE_POOL)
  const pool = unwrapList<{ id: string }>(poolRes, { site: `${SITE}.drafts.pool` })
  if (pool.length === 0) return []

  const since = new Date(now.getTime() - DRAFT_RECHECK_DAYS * DAY_MS).toISOString()
  const askedRes = await supabase.from('agent_tasks').select('prospect_id')
    .eq('task_type', 'draft_outreach')
    .in('prospect_id', pool.map((p) => p.id))
    .gte('created_at', since)
    .limit(CANDIDATE_POOL)
  const asked = unwrapList<{ prospect_id: string | null }>(askedRes, { site: `${SITE}.drafts.asked` })
  const skip = new Set(asked.map((a) => a.prospect_id))
  return pool.map((p) => p.id).filter((id) => !skip.has(id)).slice(0, MAX_SALES_OPS_HANDOFFS)
}

export async function loadReportInput(supabase: ServiceClient, now: Date): Promise<ReportInput> {
  const week = new Date(now.getTime() - 7 * DAY_MS)
  const fortnight = new Date(now.getTime() - 14 * DAY_MS)

  const [thisWeek, twoWeeks, stale, hygiene, candidates, drafts] = await Promise.all([
    fetchRollup(supabase, { touchesSince: week, spendSince: centralDayStart(now) }),
    fetchRollup(supabase, { touchesSince: fortnight, spendSince: centralDayStart(now) }),
    loadStale(supabase, now),
    loadHygiene(supabase),
    loadEnrichCandidates(supabase, now),
    loadDraftCandidates(supabase, now),
  ])
  if (!thisWeek.ok) throw new Error(`rollup failed: ${thisWeek.error}`)
  if (!twoWeeks.ok) throw new Error(`rollup failed: ${twoWeeks.error}`)

  return {
    now,
    funnel:           thisWeek.rollup.funnel,
    touchesThisWeek:  thisWeek.rollup.touches,
    touchesPriorWeek: priorWeekTouches(twoWeeks.rollup.touches, thisWeek.rollup.touches),
    staleCount:       stale.count,
    staleExamples:    stale.examples,
    ...hygiene,
    enrichCandidates: candidates,
    draftCandidates:  drafts,
    spendTodayCents:  ['manager', 'lead_gen', 'content_brand', 'sales_ops', 'rev_ops']
      .reduce((total, t) => total + spentTodayCents(thisWeek.rollup, t as 'manager'), 0),
  }
}

// ── handlers ────────────────────────────────────────────────────────────────

async function runReport(_task: AgentTask, ctx: TaskContext) {
  const input = await loadReportInput(ctx.supabase, ctx.now)
  const report = buildWeeklyReport(input)
  return { kind: 'propose' as const, output: report as unknown as JsonObject }
}

function handoffIds(output: Json | null, key: 'lead_gen_enrich' | 'sales_ops_draft', cap: number): string[] {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return []
  const handoff = output.handoff
  if (typeof handoff !== 'object' || handoff === null || Array.isArray(handoff)) return []
  const ids = handoff[key]
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === 'string').slice(0, cap)
}

/**
 * Approving the report is the handoff. Each account becomes a Lead Gen task,
 * itself propose-only, so the second approval (what to actually save) is still
 * ahead. Lead Gen being off, over its cap or already asked about an account are
 * all ordinary answers recorded in the output, never failures.
 */
interface HandoffSpec { team: 'lead_gen' | 'sales_ops'; taskType: string; priority: number; periodDays: number }

/** One queued task per account, each carrying its own dedupe key so a replay cannot queue it twice. */
async function handOff(
  task: AgentTask,
  ctx: TaskContext,
  ids: readonly string[],
  spec: HandoffSpec,
): Promise<Record<string, number>> {
  const period = Math.floor(ctx.now.getTime() / (spec.periodDays * DAY_MS))
  const tally: Record<string, number> = { requested: ids.length, queued: 0 }

  // At most a handful, each a single guarded insert.
  for (const prospectId of ids) {
    const result = await enqueueTask(ctx.supabase, {
      team:       spec.team,
      taskType:   spec.taskType,
      origin:     'rev_ops',
      prospectId,
      parent:     { id: task.id, depth: task.depth },
      dedupeKey:  `${spec.team}:${spec.taskType}:${prospectId}:${period}`,
      priority:   spec.priority,
      now:        ctx.now,
    })
    const key = result.ok ? 'queued' : result.reason
    tally[key] = (tally[key] ?? 0) + 1
  }
  return tally
}

/**
 * Approving the report is the handoff. Each account becomes a task for the
 * receiving team, itself propose-only, so the second approval (what to actually
 * save, or whether the draft is any good) is still ahead. A team being off, over
 * its cap, or already asked about an account are ordinary answers recorded in
 * the output, never failures.
 */
async function executeReport(task: AgentTask, ctx: TaskContext) {
  const leadGen = await handOff(task, ctx, handoffIds(task.output, 'lead_gen_enrich', MAX_LEAD_GEN_HANDOFFS), {
    team: 'lead_gen', taskType: 'enrich_account', priority: 40, periodDays: ENRICH_RECHECK_DAYS,
  })
  const salesOps = await handOff(task, ctx, handoffIds(task.output, 'sales_ops_draft', MAX_SALES_OPS_HANDOFFS), {
    team: 'sales_ops', taskType: 'draft_outreach', priority: 50, periodDays: DRAFT_RECHECK_DAYS,
  })
  return { output: { handoff: leadGen, sales_ops_handoff: salesOps } as JsonObject }
}

/** The weekly report. It has an execute step (the handoff), so it is typed as having one. */
export const weeklyReportHandler: Required<TaskHandler> = { run: runReport, execute: executeReport }

export const revOpsHandlers: HandlerRegistry = {
  [REV_OPS_TASK_TYPES.weeklyFunnelReport]: weeklyReportHandler,
}
