import 'server-only'
import { unwrapCount, unwrapList } from '@/lib/supabase/unwrap'
import type { createServiceClient } from '@/lib/supabase/server'
import type { AgentTask } from '@/types/database'
import type { Json } from '@/types/database.generated'
import { centralDayStart } from '../policy'
import { fetchRollup, spentTodayCents } from '../rollup'
import { enqueueTask, type JsonObject } from '../tasks'
import { OWNERREZ } from './queue-candidates'
import { DAY_MS, DRAFT_RECHECK_DAYS, ENRICH_RECHECK_DAYS, handOff } from './handoff'
import { QUEUE_TASK_TYPE } from './lead-gen-queue'
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
const STALE_EXAMPLES_SHOWN = 5
/** Candidates read for the draft list before filtering out accounts already asked about. */
const CANDIDATE_POOL = 50
/** One queue proposal per this many days from the weekly report. A manual request is separate. */
const QUEUE_PROPOSAL_DAYS = 7

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
  // OwnerRez accounts first: they are the ones the queue criteria can actually use, so
  // spending the weekly allowance on them gets accounts to the queue sooner.
  const ownerRez = await collectUnasked(supabase, now, 'ownerrez', MAX_LEAD_GEN_HANDOFFS)
  if (ownerRez.length >= MAX_LEAD_GEN_HANDOFFS) return ownerRez
  const rest = await collectUnasked(supabase, now, 'rest', MAX_LEAD_GEN_HANDOFFS - ownerRez.length)
  return [...ownerRez, ...rest]
}

const SCAN_PAGE = 100
/** Pages scanned per group: bounded, so the read is. 1,000 accounts a group is far past one week's allowance. */
const SCAN_PAGES = 10

/**
 * Up to `want` accounts Lead Gen has not looked at lately. Pages through the
 * candidates in a stable order and drops the already-asked ones PER PAGE, because
 * filtering after one fixed-size read would stall once that first slice was all
 * asked about: the later weeks would be handed nothing while thousands waited.
 */
async function collectUnasked(supabase: ServiceClient, now: Date, group: 'ownerrez' | 'rest', want: number): Promise<string[]> {
  const since = new Date(now.getTime() - ENRICH_RECHECK_DAYS * DAY_MS).toISOString()
  const found: string[] = []
  for (let page = 0; page < SCAN_PAGES && found.length < want; page++) {
    const poolRes = await supabase.from('prospect_accounts').select('id')
      .in('status', ['new', 'researching', 'needs_contact_info'])
      .is('email', null)
      .or('website.not.is.null,domain.not.is.null')
      .or(group === 'ownerrez' ? `pms.ilike.${OWNERREZ}` : `pms.is.null,pms.not.ilike.${OWNERREZ}`)
      .order('score_a', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
      .range(page * SCAN_PAGE, page * SCAN_PAGE + SCAN_PAGE - 1)
    const pool = unwrapList<{ id: string }>(poolRes, { site: `${SITE}.candidates.pool` })
    if (pool.length === 0) break

    const askedRes = await supabase.from('agent_tasks').select('prospect_id')
      .eq('task_type', 'enrich_account')
      .in('prospect_id', pool.map((p) => p.id))
      .gte('created_at', since)
      .limit(SCAN_PAGE)
    const asked = new Set(unwrapList<{ prospect_id: string | null }>(askedRes, { site: `${SITE}.candidates.asked` }).map((a) => a.prospect_id))
    found.push(...pool.map((p) => p.id).filter((id) => !asked.has(id)))
    if (pool.length < SCAN_PAGE) break
  }
  return found.slice(0, want)
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
 * Approving the report is the handoff. Each account becomes a task for the
 * receiving team, itself propose-only, so the second approval (what to actually
 * save, or whether the draft is any good) is still ahead. A team being off, over
 * its cap, or already asked about an account are ordinary answers recorded in
 * the output, never failures.
 */
async function executeReport(task: AgentTask, ctx: TaskContext) {
  const leadGen = await handOff(task, ctx, handoffIds(task.output, 'lead_gen_enrich', MAX_LEAD_GEN_HANDOFFS), {
    team: 'lead_gen', taskType: 'enrich_account', origin: 'rev_ops', priority: 40, periodDays: ENRICH_RECHECK_DAYS,
  })
  const salesOps = await handOff(task, ctx, handoffIds(task.output, 'sales_ops_draft', MAX_SALES_OPS_HANDOFFS), {
    team: 'sales_ops', taskType: 'draft_outreach', origin: 'rev_ops', priority: 50, periodDays: DRAFT_RECHECK_DAYS,
  })
  const queue = await requestQueueProposal(task, ctx)
  return { output: { handoff: leadGen, sales_ops_handoff: salesOps, queue_handoff: queue } as JsonObject }
}

/**
 * Asks Lead Gen which accounts to move to queued, so there are first drafts to
 * ask Sales Ops for next week. One task, not one per account: the list is Lead
 * Gen's to propose and a person's to approve. Lead Gen being off, or already asked
 * this period, are ordinary answers recorded in the output.
 */
async function requestQueueProposal(task: AgentTask, ctx: TaskContext): Promise<Record<string, number>> {
  const period = Math.floor(ctx.now.getTime() / (QUEUE_PROPOSAL_DAYS * DAY_MS))
  const result = await enqueueTask(ctx.supabase, {
    team:      'lead_gen',
    taskType:  QUEUE_TASK_TYPE,
    origin:    'rev_ops',
    parent:    { id: task.id, depth: task.depth },
    dedupeKey: `lead_gen:${QUEUE_TASK_TYPE}:${period}`,
    priority:  45,
    now:       ctx.now,
  })
  return { [result.ok ? 'queued' : result.reason]: 1 }
}

/** The weekly report. It has an execute step (the handoff), so it is typed as having one. */
export const weeklyReportHandler: Required<TaskHandler> = { run: runReport, execute: executeReport }

export const revOpsHandlers: HandlerRegistry = {
  [REV_OPS_TASK_TYPES.weeklyFunnelReport]: weeklyReportHandler,
}
