import 'server-only'
import { unwrapList } from '@/lib/supabase/unwrap'
import type { createServiceClient } from '@/lib/supabase/server'
import type { Json } from '@/types/database.generated'
import { OPEN_TASK_STATUSES, isWorkerTeam, type TaskOrigin, type WorkerTeam } from '../constants'
import { centralDateKey, isTeamRunnable } from '../policy'
import { enqueueTask, loadTeamSettings, type EnqueueResult } from '../tasks'
import { QUEUE_TASK_TYPE } from '../teams/lead-gen-queue'
import { REV_OPS_TASK_TYPES } from '../teams/rev-ops'
import { DRAFTABLE_STAGES } from '../teams/sales-ops-eligibility'
import { effectiveLimit, type ActionParams, type ProposedAction } from './instructions'

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

/** How far back a rejected draft is still worth another go. */
export const REDRAFT_WINDOW_DAYS = 30
/** An account Lead Gen already looked at is not asked about again for this long. Matches Rev Ops, so both paths dedupe on one key. */
const ENRICH_RECHECK_DAYS = 30
/** Candidates read before the filters. A short, known list: the filters need every one. */
const CANDIDATE_POOL = 50
const ENRICH_STAGES = ['new', 'researching', 'needs_contact_info'] as const
/** Accounts a person supplied by hand carry this source prefix (founder_list_<date>), and only they get meeting requests. */
export const FOUNDER_LIST_SOURCE = 'founder\\_list\\_%'
/** Stages a meeting request may start from: nothing has gone out yet. */
const MEETING_REQUEST_STAGES = [...ENRICH_STAGES, 'queued'] as const

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

/** Tallies enqueue results into "queued" and the reasons the rest were not. */
function tallyResults(results: readonly EnqueueResult[]): { queued: number; refused: number; firstRefusal: string | null } {
  const queuedCount = results.filter((r) => r.ok).length
  const refusals = results.flatMap((r) => (r.ok ? [] : [r]))
  const hardRefusals = refusals.filter((r) => r.reason !== 'duplicate')
  return {
    queued:       queuedCount,
    refused:      hardRefusals.length,
    firstRefusal: hardRefusals.length ? REFUSALS[hardRefusals[0].reason] : null,
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

async function redraftRejected(supabase: ServiceClient, ctx: ApplyContext, params: ActionParams): Promise<ActionOutcome> {
  const kind = 'redraft_rejected' as const
  const since = new Date(ctx.now.getTime() - REDRAFT_WINDOW_DAYS * DAY_MS).toISOString()

  const rejectedRes = await supabase.from('agent_tasks').select('prospect_id')
    .eq('team', 'sales_ops').eq('task_type', 'draft_outreach').eq('status', 'rejected')
    .not('prospect_id', 'is', null)
    .gte('decided_at', since)
    .order('decided_at', { ascending: false })
    .limit(CANDIDATE_POOL)
  const rejected = unwrapList<{ prospect_id: string | null }>(rejectedRes, { site: `${SITE}.redraft.rejected` })
  const ids = [...new Set(rejected.flatMap((r) => (r.prospect_id ? [r.prospect_id] : [])))]
  if (ids.length === 0) return { kind, ok: true, summary: 'No drafts were rejected in the last 30 days, so there was nothing to redo.' }

  const liveRes = await supabase.from('agent_tasks').select('prospect_id')
    .eq('team', 'sales_ops').eq('task_type', 'draft_outreach')
    .in('status', [...OPEN_TASK_STATUSES])
    .in('prospect_id', ids)
    .limit(ids.length)
  const live = new Set(unwrapList<{ prospect_id: string | null }>(liveRes, { site: `${SITE}.redraft.live` }).map((r) => r.prospect_id))

  // An account that has moved on (replied, in a trial, closed) is not redrafted: it needs a person, not a template.
  const stageRes = await supabase.from('prospect_accounts').select('id')
    .in('id', ids).in('status', [...DRAFTABLE_STAGES]).limit(ids.length)
  const draftable = new Set(unwrapList<{ id: string }>(stageRes, { site: `${SITE}.redraft.stage` }).map((r) => r.id))

  const chosen = ids.filter((id) => !live.has(id) && draftable.has(id)).slice(0, effectiveLimit(kind, params))
  if (chosen.length === 0) {
    return { kind, ok: true, summary: 'Every account with a rejected draft already has a draft waiting or has moved on, so nothing was redone.' }
  }

  const day = centralDateKey(ctx.now)
  const results: EnqueueResult[] = []
  for (const prospectId of chosen) {
    results.push(await enqueueTask(supabase, {
      team:             'sales_ops',
      taskType:         'draft_outreach',
      origin:           ctx.origin,
      prospectId,
      priority:         55,
      requiresApproval: true,
      dedupeKey:        `sales_ops:draft_outreach:${prospectId}:redraft:${day}`,
      now:              ctx.now,
    }))
  }
  const tally = tallyResults(results)
  if (tally.queued === 0 && tally.firstRefusal) return { kind, ok: false, summary: tally.firstRefusal }
  return {
    kind, ok: true,
    summary: `Asked Sales Ops to redraft ${plural(tally.queued, 'account', 'accounts')}, using the notes you left on rejected drafts. Each new draft will wait for your approval.`,
  }
}

async function enrichOwnerrez(supabase: ServiceClient, ctx: ApplyContext, params: ActionParams): Promise<ActionOutcome> {
  const kind = 'enrich_ownerrez' as const

  const poolRes = await supabase.from('prospect_accounts').select('id')
    .ilike('pms', 'OwnerRez')
    .in('status', [...ENRICH_STAGES])
    .is('email', null)
    .or('website.not.is.null,domain.not.is.null')
    .order('score_a', { ascending: false, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(CANDIDATE_POOL)
  const pool = unwrapList<{ id: string }>(poolRes, { site: `${SITE}.enrich.pool` }).map((p) => p.id)
  if (pool.length === 0) return { kind, ok: true, summary: 'No OwnerRez accounts are missing an email and have a site to read.' }

  const since = new Date(ctx.now.getTime() - ENRICH_RECHECK_DAYS * DAY_MS).toISOString()
  const askedRes = await supabase.from('agent_tasks').select('prospect_id')
    .eq('task_type', 'enrich_account').in('prospect_id', pool).gte('created_at', since).limit(pool.length)
  const asked = new Set(unwrapList<{ prospect_id: string | null }>(askedRes, { site: `${SITE}.enrich.asked` }).map((r) => r.prospect_id))

  const chosen = pool.filter((id) => !asked.has(id)).slice(0, effectiveLimit(kind, params))
  if (chosen.length === 0) {
    return { kind, ok: true, summary: 'Lead Gen has already looked at every OwnerRez account that is missing an email in the last 30 days.' }
  }

  // The same key Rev Ops uses, so an account both paths pick is queued once.
  const period = Math.floor(ctx.now.getTime() / (ENRICH_RECHECK_DAYS * DAY_MS))
  const results: EnqueueResult[] = []
  for (const prospectId of chosen) {
    results.push(await enqueueTask(supabase, {
      team:             'lead_gen',
      taskType:         'enrich_account',
      origin:           ctx.origin,
      prospectId,
      priority:         65,
      requiresApproval: true,
      dedupeKey:        `lead_gen:enrich_account:${prospectId}:${period}`,
      now:              ctx.now,
    }))
  }
  const tally = tallyResults(results)
  if (tally.queued === 0 && tally.firstRefusal) return { kind, ok: false, summary: tally.firstRefusal }
  return {
    kind, ok: true,
    summary: `Asked Lead Gen to look for contact details for ${plural(tally.queued, 'OwnerRez account', 'OwnerRez accounts')}. What it finds will wait for your approval.`,
  }
}

async function draftMeetingRequests(supabase: ServiceClient, ctx: ApplyContext, params: ActionParams): Promise<ActionOutcome> {
  const kind = 'draft_meeting_requests' as const

  const poolRes = await supabase.from('prospect_accounts').select('id, email_status')
    .like('source', FOUNDER_LIST_SOURCE)
    .ilike('pms', 'OwnerRez')
    .in('status', [...MEETING_REQUEST_STAGES])
    .not('email', 'is', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(CANDIDATE_POOL)
  const pool = unwrapList<{ id: string; email_status: string | null }>(poolRes, { site: `${SITE}.meeting.pool` })
    .filter((p) => p.email_status !== 'bounced')
    .map((p) => p.id)
  if (pool.length === 0) {
    return { kind, ok: true, summary: 'None of the accounts from your lists has an email yet and is waiting for a first email. Approve what Lead Gen finds first.' }
  }

  // An account with a draft already waiting does not get a second one.
  const liveRes = await supabase.from('agent_tasks').select('prospect_id')
    .eq('team', 'sales_ops').eq('task_type', 'draft_outreach')
    .in('status', [...OPEN_TASK_STATUSES])
    .in('prospect_id', pool)
    .limit(pool.length)
  const live = new Set(unwrapList<{ prospect_id: string | null }>(liveRes, { site: `${SITE}.meeting.live` }).map((r) => r.prospect_id))

  const chosen = pool.filter((id) => !live.has(id)).slice(0, effectiveLimit(kind, params))
  if (chosen.length === 0) return { kind, ok: true, summary: 'Every account from your lists that has an email already has a draft waiting.' }

  const period = Math.floor(ctx.now.getTime() / (ENRICH_RECHECK_DAYS * DAY_MS))
  const results: EnqueueResult[] = []
  for (const prospectId of chosen) {
    results.push(await enqueueTask(supabase, {
      team:             'sales_ops',
      taskType:         'draft_outreach',
      origin:           ctx.origin,
      prospectId,
      input:            { intent: 'meeting_request' },
      priority:         60,
      requiresApproval: true,
      dedupeKey:        `sales_ops:draft_outreach:${prospectId}:meeting:${period}`,
      now:              ctx.now,
    }))
  }
  const tally = tallyResults(results)
  if (tally.queued === 0 && tally.firstRefusal) return { kind, ok: false, summary: tally.firstRefusal }
  return {
    kind, ok: true,
    summary: `Asked Sales Ops to draft a meeting request for ${plural(tally.queued, 'account', 'accounts')} from your lists. You review each draft and send it yourself.`,
  }
}

export async function applyAction(supabase: ServiceClient, action: ProposedAction, ctx: ApplyContext): Promise<ActionOutcome> {
  switch (action.kind) {
    case 'run_funnel_report':         return runReport(supabase, ctx)
    case 'propose_queue_candidates':  return runQueueProposal(supabase, ctx)
    case 'requeue_failed':            return requeueFailed(supabase, ctx, action.params.team)
    case 'redraft_rejected':          return redraftRejected(supabase, ctx, action.params)
    case 'enrich_ownerrez':           return enrichOwnerrez(supabase, ctx, action.params)
    case 'draft_meeting_requests':    return draftMeetingRequests(supabase, ctx, action.params)
  }
}

/** The outcomes as the JSON column stores them. */
export function outcomesJson(outcomes: readonly ActionOutcome[]): Json {
  return outcomes.map((o) => ({ kind: o.kind, ok: o.ok, summary: o.summary }))
}
