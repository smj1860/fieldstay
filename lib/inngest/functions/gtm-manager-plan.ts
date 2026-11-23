import type { Json }           from '@/types/database.generated'
import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError }         from '@/lib/observability/report-error'
import { unwrapCount }         from '@/lib/supabase/unwrap'
import { centralDateKey, isTeamRunnable } from '@/lib/gtm/policy'
import { loadTeamSettings }    from '@/lib/gtm/tasks'
import { loadInstructionFacts } from '@/lib/gtm/manager/facts'
import { loadLearningContext } from '@/lib/gtm/manager/history'
import { holdStanding, type ProposedAction } from '@/lib/gtm/manager/instructions'
import { buildPlan, recentlyRejectedKinds } from '@/lib/gtm/manager/triggers'

// ============================================================================
// The manager's own morning plan.
//
// Until now the manager only acted when a person replied to a brief or a granted
// type came due. This is it taking the initiative, and it takes it the only way
// the rest of the design allows: it PROPOSES. Each morning it reads the day's
// counts, works out which instruction types the pipeline actually calls for
// (lib/gtm/manager/triggers.ts, deterministic, no model), and writes ONE plan row
// for a person to approve in the same card as a reply. Nothing is queued until
// that approval, through the same decideManagerInstruction() a reply uses.
//
// What it will not do:
//   - Propose a type a person already handed over (that one runs on its own).
//   - Propose a type a person rejected in the last week.
//   - Add a plan while the last one is still waiting, or while the inbox already
//     holds a pile: more proposals would only bury the ones that matter.
//   - Do anything at all unless the master switch and the manager are on.
//
// It runs ten minutes after the morning brief and before the standing runner, so
// a person reads the brief, then the plan, and anything they have handed over runs
// after.
// ============================================================================

const SITE = 'inngest.gtm-manager-plan'

export interface PlanGather {
  skip:    'manager_off' | 'inbox_full' | 'plan_waiting' | 'nothing_warranted' | null
  actions: ProposedAction[]
  reasons: string[]
  dateKey: string
}

export async function gatherPlan(): Promise<PlanGather> {
  const supabase = createServiceClient({ system: 'inngest:gtm-manager-plan.gather' })
  const now = new Date()
  const base = { actions: [], reasons: [], dateKey: centralDateKey(now) }

  const settings = await loadTeamSettings(supabase)
  if (!isTeamRunnable(settings, 'manager')) return { skip: 'manager_off', ...base }

  const facts = await loadInstructionFacts(supabase, now)
  if (holdStanding(facts.waitingForApproval)) return { skip: 'inbox_full', ...base }

  const waitingRes = await supabase.from('manager_instructions')
    .select('id', { count: 'exact', head: true }).eq('source', 'manager').eq('status', 'proposed')
  if (unwrapCount(waitingRes, { site: `${SITE}.waiting` }) > 0) return { skip: 'plan_waiting', ...base }

  const context = await loadLearningContext(supabase)
  const plan = buildPlan({
    facts, now,
    lastRunAt:        context.lastRunAt,
    granted:          context.granted,
    recentlyRejected: recentlyRejectedKinds(context.records, now),
  })
  return { skip: plan.actions.length === 0 ? 'nothing_warranted' : null, ...plan, dateKey: base.dateKey }
}

export async function writePlan(gathered: PlanGather): Promise<{ written: boolean }> {
  const supabase = createServiceClient({ system: 'inngest:gtm-manager-plan.write' })
  const { error } = await supabase.from('manager_instructions').insert({
    source:       'manager',
    instruction:  `Morning plan, ${gathered.dateKey}`,
    status:       'proposed',
    reply:        `${gathered.reasons.join(' ')} Approve to queue it. Each piece still waits for your approval before anything moves.`,
    proposal:     gathered.actions as unknown as Json,
    action_kinds: gathered.actions.map((a) => a.kind),
    dedupe_key:   `plan:${gathered.dateKey}`,
  })
  // 23505: today's plan was already written by an earlier attempt of this step.
  if (error && error.code !== '23505') {
    reportError(error, { site: `${SITE}.write` })
    throw error
  }
  return { written: !error }
}

export const gtmManagerPlan = inngest.createFunction(
  { id: 'cron-gtm-manager-plan', name: 'Cron: GTM Manager Morning Plan', retries: 2 },
  { cron: '20 12 * * *' },  // 7:20am CT (UTC-5), after the 7:00 brief and before the 7:30 standing runner
  async ({ step }) => {
    const gathered = await step.run('gather', gatherPlan)
    if (gathered.skip) return { skip: gathered.skip, proposed: [] as string[] }
    await step.run('write', () => writePlan(gathered))
    return { skip: null, proposed: gathered.actions.map((a) => a.kind) }
  },
)
