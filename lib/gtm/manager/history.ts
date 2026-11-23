import 'server-only'
import { unwrapList } from '@/lib/supabase/unwrap'
import type { createServiceClient } from '@/lib/supabase/server'
import {
  ACTION_KINDS,
  INSTRUCTION_HISTORY_LIMIT,
  isActionKind,
  lastActivityAt,
  learnFromHistory,
  recordsFromRows,
  type ActionKind,
  type InstructionHistoryRow,
  type InstructionRecord,
  type KindLearning,
} from './instructions'

/**
 * What the manager has learned and what a person has handed it, read once for
 * the two jobs that need it (the morning plan and the standing runner), so both
 * see the same history and neither re-derives it.
 *
 * The history is a person's decisions on their own replies AND on the manager's
 * plans. Its own standing runs are left out (see learnFromHistory).
 */

type ServiceClient = ReturnType<typeof createServiceClient>

const SITE = 'gtm.manager.history'

interface PlaybookRow { action_kind: string; standing: boolean; last_standing_run_at: string | null }

export interface LearningContext {
  records:   InstructionRecord[]
  learning:  KindLearning[]
  /** the types a person has handed to the manager */
  granted:   Set<ActionKind>
  /** per type, the later of the last standing run and the last approval */
  lastRunAt: Partial<Record<ActionKind, string | null>>
}

export async function loadLearningContext(supabase: ServiceClient): Promise<LearningContext> {
  const historyRes = await supabase.from('manager_instructions')
    .select('source, status, action_kinds, decided_at')
    .in('source', ['human', 'manager'])
    .order('created_at', { ascending: false })
    .limit(INSTRUCTION_HISTORY_LIMIT)
  const history = unwrapList<InstructionHistoryRow>(historyRes, { site: `${SITE}.history` })

  const playbookRes = await supabase.from('manager_playbook')
    .select('action_kind, standing, last_standing_run_at')
    .limit(ACTION_KINDS.length)
  const playbook = unwrapList<PlaybookRow>(playbookRes, { site: `${SITE}.playbook` })

  const records = recordsFromRows(history)
  const learning = learnFromHistory(records)

  const granted = new Set<ActionKind>()
  const lastRunAt: Partial<Record<ActionKind, string | null>> = {}
  for (const learned of learning) {
    const row = playbook.find((p) => p.action_kind === learned.kind)
    if (row?.standing === true && isActionKind(row.action_kind)) granted.add(row.action_kind)
    lastRunAt[learned.kind] = lastActivityAt(learned, row?.last_standing_run_at ?? null)
  }
  return { records, learning, granted, lastRunAt }
}
