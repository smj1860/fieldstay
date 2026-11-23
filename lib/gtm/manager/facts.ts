import 'server-only'
import { unwrapCount, unwrapList } from '@/lib/supabase/unwrap'
import type { createServiceClient } from '@/lib/supabase/server'
import { OPEN_TASK_STATUSES, isWorkerTeam, type WorkerTeam } from '../constants'
import { REDRAFT_WINDOW_DAYS } from './apply'
import type { InstructionFacts } from './instructions'

/**
 * Reads the handful of counts the manager is shown with a reply (see
 * InstructionFacts). Counts only, every read bounded, nothing about any one
 * account. A read that fails throws, and the caller treats that as "could not
 * read the reply just now" rather than answering from numbers it does not have.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

const SITE = 'gtm.manager.facts'
const DAY_MS = 86_400_000
const FAILED_WINDOW_DAYS = 7
/** Failed rows read to count them by team. A ceiling: a week of failures past this is already a problem the count cannot hide. */
const FAILED_READ = 500
const CANDIDATE_POOL = 50

async function failedByTeam(supabase: ServiceClient, now: Date): Promise<Partial<Record<WorkerTeam, number>>> {
  const since = new Date(now.getTime() - FAILED_WINDOW_DAYS * DAY_MS).toISOString()
  const res = await supabase.from('agent_tasks').select('team')
    .eq('status', 'failed').gte('updated_at', since).limit(FAILED_READ)
  const counts: Partial<Record<WorkerTeam, number>> = {}
  for (const row of unwrapList<{ team: string }>(res, { site: `${SITE}.failed` })) {
    if (isWorkerTeam(row.team)) counts[row.team] = (counts[row.team] ?? 0) + 1
  }
  return counts
}

async function rejectedDraftAccounts(supabase: ServiceClient, now: Date): Promise<number> {
  const since = new Date(now.getTime() - REDRAFT_WINDOW_DAYS * DAY_MS).toISOString()
  const rejectedRes = await supabase.from('agent_tasks').select('prospect_id')
    .eq('team', 'sales_ops').eq('task_type', 'draft_outreach').eq('status', 'rejected')
    .not('prospect_id', 'is', null).gte('decided_at', since).limit(CANDIDATE_POOL)
  const ids = [...new Set(unwrapList<{ prospect_id: string | null }>(rejectedRes, { site: `${SITE}.rejected` })
    .flatMap((r) => (r.prospect_id ? [r.prospect_id] : [])))]
  if (ids.length === 0) return 0

  const liveRes = await supabase.from('agent_tasks').select('prospect_id')
    .eq('team', 'sales_ops').eq('task_type', 'draft_outreach')
    .in('status', [...OPEN_TASK_STATUSES]).in('prospect_id', ids).limit(ids.length)
  const live = new Set(unwrapList<{ prospect_id: string | null }>(liveRes, { site: `${SITE}.live` }).map((r) => r.prospect_id))
  return ids.filter((id) => !live.has(id)).length
}

export async function loadInstructionFacts(supabase: ServiceClient, now: Date): Promise<InstructionFacts> {
  const [failed, rejected, ownerrez, waiting] = await Promise.all([
    failedByTeam(supabase, now),
    rejectedDraftAccounts(supabase, now),
    supabase.from('prospect_accounts').select('id', { count: 'exact', head: true })
      .ilike('pms', 'OwnerRez').in('status', ['new', 'researching', 'needs_contact_info']).is('email', null)
      .or('website.not.is.null,domain.not.is.null'),
    supabase.from('agent_tasks').select('id', { count: 'exact', head: true }).eq('status', 'needs_approval'),
  ])
  return {
    failedByTeam:           failed,
    rejectedDraftAccounts:  rejected,
    ownerrezNeedingContact: unwrapCount(ownerrez, { site: `${SITE}.ownerrez` }),
    waitingForApproval:     unwrapCount(waiting, { site: `${SITE}.waiting` }),
  }
}
