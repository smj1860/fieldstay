import 'server-only'
import { reportError } from '@/lib/observability/report-error'
import type { createServiceClient } from '@/lib/supabase/server'
import type { AgentTask } from '@/types/database'
import type { Json } from '@/types/database.generated'
import type { JsonObject } from '../tasks'
import { MAX_QUEUE_PROPOSAL, PRE_QUEUE_STATUSES } from './queue-candidates'

/**
 * The only place an agent changes a prospect's STAGE, and the only stage it can
 * set is 'queued', reached only from an approved proposal.
 *
 * Four rules hold the door (unit/guardrails/gtm-agent-boundaries.test.ts checks
 * each one against this file):
 *   1. No recorded decision on the task, no write.
 *   2. The only status this file may name is 'queued'. Emailed, replied, won,
 *      lost and every other stage belong to a person, or to a person's click.
 *   3. The UPDATE carries its own precondition (`status IN` a pre-queue stage and
 *      an email still present), not a read before it: a person can move or edit an
 *      account between approval and application, and theirs must win.
 *   4. It deletes nothing and writes no field but the stage.
 *
 * Moving an account to 'queued' sends nothing. It makes the account eligible for
 * the next report to ask Sales Ops for a first draft, which a person still
 * reviews and sends themselves.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

const SITE = 'gtm.queue.apply'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The proposal's account ids, re-validated. Anything that does not parse is dropped, never "fixed up". */
export function parseApprovedAccountIds(output: Json | null): string[] {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return []
  const ids = output.account_ids
  if (!Array.isArray(ids)) return []
  const valid = ids.filter((id): id is string => typeof id === 'string' && UUID.test(id))
  return [...new Set(valid)].slice(0, MAX_QUEUE_PROPOSAL)
}

export async function applyApprovedQueue(supabase: ServiceClient, task: AgentTask): Promise<JsonObject> {
  if (!task.decided_at) throw new Error('Refusing to apply a proposal that no person approved')

  const ids = parseApprovedAccountIds(task.output)
  if (ids.length === 0) return { queued: [], skipped: 0, reason: 'no_valid_accounts' }

  const { data, error } = await supabase
    .from('prospect_accounts')
    .update({ status: 'queued' })
    .in('id', ids)
    .in('status', [...PRE_QUEUE_STATUSES])
    .not('email', 'is', null)
    .select('id')

  if (error) {
    reportError(error, { site: `${SITE}.update`, extra: { taskId: task.id, requested: ids.length } })
    throw error
  }

  const queued = (data ?? []).map((row) => row.id)
  if (queued.length > 0) await logQueued(supabase, task, queued)
  // Accounts a person moved, closed or emptied of email since the proposal was written: theirs wins.
  return { queued, skipped: ids.length - queued.length }
}

/**
 * One history note per account, so the funnel reads the way it happened and says a
 * person approved it. Best-effort: the stage change is saved either way, so a
 * failure here is reported and swallowed rather than undoing a write that landed.
 */
async function logQueued(supabase: ServiceClient, task: AgentTask, ids: readonly string[]): Promise<void> {
  const { error } = await supabase.from('prospect_touches').insert(
    ids.map((prospect_id) => ({
      prospect_id,
      touch_type: 'note',
      note:       'Moved to queued by Lead Gen (approved).',
      actor_id:   task.decided_by,
    })),
  )
  if (error) reportError(error, { site: `${SITE}.note`, level: 'warning', extra: { taskId: task.id } })
}
