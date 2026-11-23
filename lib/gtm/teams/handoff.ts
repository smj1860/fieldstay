import 'server-only'
import type { AgentTask } from '@/types/database'
import { enqueueTask } from '../tasks'
import type { TaskOrigin } from '../constants'
import type { TaskContext } from '../worker'

/**
 * Handing accounts to another team as tasks. Shared by Rev Ops (the weekly report)
 * and Lead Gen (accounts it just queued), so both build the SAME dedupe key for the
 * same account and period: whichever asks first wins, and the other is told
 * 'duplicate' rather than creating a second draft task for one account.
 */

export const DAY_MS = 86_400_000

/** An account Lead Gen already looked at is not asked about again for this long. */
export const ENRICH_RECHECK_DAYS = 30

/** An account Sales Ops already drafted for is not offered again for this long. Also the length of one dedupe period. */
export const DRAFT_RECHECK_DAYS = 14

export interface HandoffSpec {
  team:       'lead_gen' | 'sales_ops'
  taskType:   string
  origin:     TaskOrigin
  priority:   number
  periodDays: number
}

/** One queued task per account, each carrying its own dedupe key so a replay cannot queue it twice. */
export async function handOff(
  task: Pick<AgentTask, 'id' | 'depth'>,
  ctx: Pick<TaskContext, 'supabase' | 'now'>,
  ids: readonly string[],
  spec: HandoffSpec,
): Promise<Record<string, number>> {
  const period = Math.floor(ctx.now.getTime() / (spec.periodDays * DAY_MS))
  const tally: Record<string, number> = { requested: ids.length, queued: 0 }

  // A bounded list (the callers cap it), each a single guarded insert.
  for (const prospectId of ids) {
    const result = await enqueueTask(ctx.supabase, {
      team:       spec.team,
      taskType:   spec.taskType,
      origin:     spec.origin,
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
