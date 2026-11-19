import 'server-only'
import { unwrapCount, unwrapList } from '@/lib/supabase/unwrap'
import type { createServiceClient } from '@/lib/supabase/server'
import type { AgentTask } from '@/types/database'
import type { JsonObject } from '../tasks'
import type { TaskContext, TaskHandler, WorkOutcome } from '../worker'
import { applyApprovedQueue } from './queue-apply'
import { DRAFT_RECHECK_DAYS, handOff } from './handoff'
import {
  CANDIDATE_READ_LIMIT, MAX_QUEUE_PROPOSAL, PRE_QUEUE_STATUSES, QUEUE_POOL_TARGET,
  LOW_COVERAGE_MARKETS, OWNERREZ, describeProposal, rankCandidates, type QueueCandidate,
} from './queue-candidates'

/**
 * Lead Gen: proposes which accounts to move to "queued".
 *
 * It reads and ranks; it changes nothing. A person approves the list, and only
 * then does queue-apply.ts move the stage, to 'queued' and nothing else. Moving an
 * account sends nothing: it makes the account eligible for the next report to ask
 * Sales Ops for a first draft, which a person still reviews and sends themselves.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

export const QUEUE_TASK_TYPE = 'queue_candidates'

const SITE = 'gtm.lead-gen.queue'

const COLUMNS = 'id, company, city, state, pms, market, portfolio_size, contact_name, email, email_is_generic, email_status, status'

async function countQueued(supabase: ServiceClient): Promise<number> {
  const res = await supabase.from('prospect_accounts').select('id', { count: 'exact', head: true }).eq('status', 'queued')
  return unwrapCount(res, { site: `${SITE}.pool` })
}

type CandidateRow = Omit<QueueCandidate, 'email_is_generic'> & { email_is_generic: boolean | null }

/** Unknown is not "not generic": a NULL reads as a role inbox, the cautious answer. */
const normalize = (rows: readonly CandidateRow[]): QueueCandidate[] =>
  rows.map((r) => ({ ...r, email_is_generic: r.email_is_generic !== false }))

/**
 * Accounts running OwnerRez that could be queued, oldest first and bounded. The
 * criterion is applied in the database, not after: with thousands of accounts, a
 * read of the oldest few hundred would never reach the ones that match.
 */
async function loadOwnerRez(supabase: ServiceClient): Promise<QueueCandidate[]> {
  const res = await supabase
    .from('prospect_accounts')
    .select(COLUMNS)
    .in('status', [...PRE_QUEUE_STATUSES])
    .ilike('pms', OWNERREZ)
    .not('email', 'is', null)
    .eq('email_is_generic', false)
    .order('created_at', { ascending: true })
    .limit(CANDIDATE_READ_LIMIT)
  return normalize(unwrapList<CandidateRow>(res, { site: `${SITE}.ownerrez` }))
}

/** Accounts in a market on the founder's list. Skipped outright while the list is empty. */
async function loadLowCoverage(supabase: ServiceClient): Promise<QueueCandidate[]> {
  if (LOW_COVERAGE_MARKETS.length === 0) return []
  const res = await supabase
    .from('prospect_accounts')
    .select(COLUMNS)
    .in('status', [...PRE_QUEUE_STATUSES])
    .in('market', [...LOW_COVERAGE_MARKETS])
    .not('email', 'is', null)
    .eq('email_is_generic', false)
    .order('created_at', { ascending: true })
    .limit(CANDIDATE_READ_LIMIT)
  return normalize(unwrapList<CandidateRow>(res, { site: `${SITE}.low-coverage` }))
}

/** Both criteria's candidates, one row per account. isQueueable() is still the one place the rules live. */
async function loadCandidates(supabase: ServiceClient): Promise<QueueCandidate[]> {
  const [ownerRez, lowCoverage] = await Promise.all([loadOwnerRez(supabase), loadLowCoverage(supabase)])
  return [...new Map([...ownerRez, ...lowCoverage].map((c) => [c.id, c])).values()]
}

function nothing(reason: string, summary: string): WorkOutcome {
  return { kind: 'nothing', output: { reason, summary } }
}

function noCandidatesSummary(): string {
  const market = LOW_COVERAGE_MARKETS.length === 0 ? ' The low-coverage market list is empty, so only OwnerRez accounts can match.' : ''
  return `No account runs OwnerRez or sits in a listed market and also has a working, personal-looking email.${market} Lead Gen needs to find more contact details first.`
}

async function runQueue(_task: AgentTask, ctx: TaskContext): Promise<WorkOutcome> {
  const queued = await countQueued(ctx.supabase)
  if (queued >= QUEUE_POOL_TARGET) {
    return nothing('pool_full', `${queued} accounts are already queued, so there is nothing to add yet.`)
  }

  const ranked = rankCandidates(await loadCandidates(ctx.supabase), LOW_COVERAGE_MARKETS).slice(0, MAX_QUEUE_PROPOSAL)
  if (ranked.length === 0) {
    return nothing('no_candidates', noCandidatesSummary())
  }

  const text = describeProposal(ranked, queued)
  return { kind: 'propose', output: { ...text, account_ids: ranked.map((c) => c.id) } as JsonObject }
}

/**
 * Applies the approved list, then asks Sales Ops for a first draft of each account
 * that actually moved. That is what makes queueing a handoff rather than a dead end:
 * without it the accounts wait for the next weekly report. Each draft is still
 * propose-only and a person reads and sends it. Uses Rev Ops's dedupe key, so the
 * weekly report cannot ask for the same account twice.
 */
async function executeQueue(task: AgentTask, ctx: TaskContext): Promise<{ output: JsonObject }> {
  const applied = await applyApprovedQueue(ctx.supabase, task)
  const queued = Array.isArray(applied.queued) ? applied.queued.filter((id): id is string => typeof id === 'string') : []
  const drafts = await handOff(task, ctx, queued, {
    team: 'sales_ops', taskType: 'draft_outreach', origin: 'lead_gen', priority: 50, periodDays: DRAFT_RECHECK_DAYS,
  })
  return { output: { ...applied, drafts_requested: drafts } as JsonObject }
}

/** Queueing has an execute step (applying what a person approved), so it is typed as having one. */
export const queueCandidatesHandler: Required<TaskHandler> = { run: runQueue, execute: executeQueue }
