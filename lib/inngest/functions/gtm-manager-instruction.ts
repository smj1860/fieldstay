import type { Json }           from '@/types/database.generated'
import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError }         from '@/lib/observability/report-error'
import { unwrapCount, unwrapList } from '@/lib/supabase/unwrap'
import { centralDateKey, centralDayStart, isTeamRunnable, settingFor } from '@/lib/gtm/policy'
import { loadTeamSettings, recordUsage } from '@/lib/gtm/tasks'
import { fetchRollup, spentTodayCents } from '@/lib/gtm/rollup'
import { mayNarrate }          from '@/lib/gtm/manager/brief'
import { applyAction, outcomesJson } from '@/lib/gtm/manager/apply'
import { interpretInstruction } from '@/lib/gtm/manager/interpret'
import {
  ACTION_KINDS,
  INSTRUCTION_HISTORY_LIMIT,
  cadenceDaysFor,
  describeAction,
  holdStanding,
  isActionKind,
  lastActivityAt,
  learnFromHistory,
  recordsFromRows,
  standingDue,
  type ActionKind,
  type InstructionHistoryRow,
} from '@/lib/gtm/manager/instructions'

// ============================================================================
// The manager reading a person's reply to its brief, and repeating what a
// person has told it to repeat.
//
// Two functions:
//   - gtmManagerInstruction: a reply was submitted. Reads it with one billed
//     model call and writes a PROPOSAL onto the row. It creates no task; a
//     person approves the proposal in the dashboard, and only that approval
//     carries it out (see decideManagerInstruction).
//   - gtmManagerStanding: a daily check for instruction types a person has
//     explicitly let the manager take over. Each one is repeated on the rhythm
//     the person's own approvals showed, through the same applyAction() a
//     person's approval uses, so the same caps, switches and approvals apply
//     to the work it queues.
//
// The manager's autonomy setting stays 'propose_only' throughout. A standing
// permission is a separate, per-instruction-type grant a person makes, and it
// can only ever repeat a catalog action: queue a task that still waits for a
// person's approval before anything moves.
// ============================================================================

const SITE = 'inngest.gtm-manager-instruction'

const UNAVAILABLE_REPLY =
  'I could not read that just now. The manager is switched off, over its spend limit for today, or has no model key. ' +
  'Nothing was done. You can send it again once that is sorted.'
const UNCLEAR_REPLY = 'I could not turn that into an action. Nothing was done. Try asking for one of the actions listed below.'

interface Loaded {
  found:      boolean
  instruction: string
  briefText:  string | null
  canModel:   boolean
}

async function load(instructionId: string): Promise<Loaded> {
  const supabase = createServiceClient({ system: 'inngest:gtm-manager-instruction.load' })

  const rowRes = await supabase
    .from('manager_instructions')
    .select('instruction, brief_id, status')
    .eq('id', instructionId)
    .maybeSingle()
  if (rowRes.error) throw rowRes.error
  const row = rowRes.data
  // Gone, or already read by an earlier attempt of this event: nothing to do.
  if (!row || row.status !== 'interpreting') return { found: false, instruction: '', briefText: null, canModel: false }

  let briefText: string | null = null
  if (row.brief_id) {
    const briefRes = await supabase.from('manager_decisions').select('brief').eq('id', row.brief_id).maybeSingle()
    if (briefRes.error) throw briefRes.error
    briefText = briefRes.data?.brief ?? null
  }

  const now = new Date()
  const settings = await loadTeamSettings(supabase)
  const rolled = await fetchRollup(supabase, { touchesSince: now, spendSince: centralDayStart(now) })
  const manager = settingFor(settings, 'manager')
  const canModel = rolled.ok && mayNarrate({
    managerRunnable: isTeamRunnable(settings, 'manager'),
    spentCents:      spentTodayCents(rolled.rollup, 'manager'),
    capCents:        manager?.daily_cost_cap_cents ?? 0,
    hasApiKey:       Boolean(process.env.ANTHROPIC_API_KEY),
  })
  return { found: true, instruction: row.instruction, briefText, canModel }
}

async function writeResult(
  instructionId: string,
  input: { status: 'proposed' | 'unclear'; reply: string; proposal: Json; kinds: string[]; model: string | null },
): Promise<void> {
  const supabase = createServiceClient({ system: 'inngest:gtm-manager-instruction.write' })
  const { error } = await supabase
    .from('manager_instructions')
    .update({
      status:       input.status,
      reply:        input.reply,
      proposal:     input.proposal,
      action_kinds: input.kinds,
      model:        input.model,
      updated_at:   new Date().toISOString(),
    })
    .eq('id', instructionId)
    // A retry of this step finds the row already read and leaves it alone.
    .eq('status', 'interpreting')
  if (error) {
    reportError(error, { site: `${SITE}.write` })
    throw error
  }
}

export const gtmManagerInstruction = inngest.createFunction(
  { id: 'gtm-manager-instruction', name: 'GTM Manager: Read an Instruction', retries: 2 },
  { event: 'gtm/manager.instruction.submitted' },
  async ({ event, step }) => {
    const id = event.data.instruction_id
    const loaded = await step.run('load', () => load(id))
    if (!loaded.found) return { skipped: true as const }

    if (!loaded.canModel) {
      await step.run('write-unavailable', () => writeResult(id, {
        status: 'unclear', reply: UNAVAILABLE_REPLY, proposal: [], kinds: [], model: null,
      }))
      return { skipped: false as const, status: 'unclear' as const }
    }

    const call = await step.run('interpret', () => interpretInstruction(loaded.instruction, loaded.briefText))

    // Billed before the answer is judged: the call cost money either way.
    await step.run('bill', async () => {
      const supabase = createServiceClient({ system: 'inngest:gtm-manager-instruction.bill' })
      await recordUsage(supabase, {
        team:         'manager',
        model:        call.model,
        inputTokens:  call.inputTokens,
        outputTokens: call.outputTokens,
        dedupeKey:    `manager:instruction:${id}`,
      })
    })

    const interpretation = call.interpretation
    const status = interpretation && interpretation.actions.length > 0 ? 'proposed' as const : 'unclear' as const
    await step.run('write', () => writeResult(id, {
      status,
      reply:    interpretation?.reply || UNCLEAR_REPLY,
      proposal: (interpretation?.actions ?? []) as unknown as Json,
      kinds:    interpretation?.actions.map((a) => a.kind) ?? [],
      model:    call.model,
    }))
    return { skipped: false as const, status }
  },
)

// ── standing instructions ───────────────────────────────────────────────────

interface PlaybookRow { action_kind: string; last_standing_run_at: string | null }
interface DueKind { kind: ActionKind; cadenceDays: number }

export interface StandingPlan {
  skip: 'manager_off' | 'inbox_full' | 'none_due' | null
  due:  DueKind[]
  dateKey: string
  nowIso:  string
}

export async function planStanding(): Promise<StandingPlan> {
  const supabase = createServiceClient({ system: 'inngest:gtm-manager-instruction.plan-standing' })
  const now = new Date()
  const base = { dateKey: centralDateKey(now), nowIso: now.toISOString() }

  const settings = await loadTeamSettings(supabase)
  if (!isTeamRunnable(settings, 'manager')) return { skip: 'manager_off', due: [], ...base }

  const waitingRes = await supabase.from('agent_tasks').select('id', { count: 'exact', head: true }).eq('status', 'needs_approval')
  if (holdStanding(unwrapCount(waitingRes, { site: `${SITE}.waiting` }))) return { skip: 'inbox_full', due: [], ...base }

  const playbookRes = await supabase.from('manager_playbook')
    .select('action_kind, last_standing_run_at').eq('standing', true).limit(ACTION_KINDS.length)
  const playbook = unwrapList<PlaybookRow>(playbookRes, { site: `${SITE}.playbook` })
  if (playbook.length === 0) return { skip: 'none_due', due: [], ...base }

  const historyRes = await supabase.from('manager_instructions')
    .select('source, status, action_kinds, decided_at')
    .eq('source', 'human')
    .order('created_at', { ascending: false })
    .limit(INSTRUCTION_HISTORY_LIMIT)
  const history = unwrapList<InstructionHistoryRow>(historyRes, { site: `${SITE}.history` })
  const learning = learnFromHistory(recordsFromRows(history))

  const due: DueKind[] = []
  for (const row of playbook) {
    if (!isActionKind(row.action_kind)) continue
    const learned = learning.find((l) => l.kind === row.action_kind)
    if (!learned) continue
    const cadenceDays = cadenceDaysFor(learned)
    if (standingDue({ now, lastRunAt: lastActivityAt(learned, row.last_standing_run_at), cadenceDays })) {
      due.push({ kind: row.action_kind, cadenceDays })
    }
  }
  return { skip: due.length === 0 ? 'none_due' : null, due, ...base }
}

export async function runStanding(kind: ActionKind, plan: StandingPlan): Promise<{ recorded: boolean }> {
  const supabase = createServiceClient({ system: 'inngest:gtm-manager-instruction.run-standing' })
  const now = new Date(plan.nowIso)

  // Enqueue and requeue are idempotent on their own (a dedupe key, and a status
  // precondition), so a retry of this step re-applies harmlessly; the row below
  // is keyed per kind per day so it is recorded once.
  const outcome = await applyAction(supabase, { kind, params: {}, summary: describeAction(kind, {}) }, { now, origin: 'manager' })

  const { error } = await supabase.from('manager_instructions').insert({
    source:       'standing',
    instruction:  `Standing instruction, repeated on its own: ${describeAction(kind, {})}`,
    status:       outcome.ok ? 'applied' : 'failed',
    reply:        outcome.summary,
    proposal:     [{ kind, params: {}, summary: describeAction(kind, {}) }] as unknown as Json,
    action_kinds: [kind],
    result:       outcomesJson([outcome]),
    applied_at:   plan.nowIso,
    dedupe_key:   `standing:${kind}:${plan.dateKey}`,
  })
  // 23505: this kind already ran today, from an earlier attempt of this step.
  if (error && error.code !== '23505') {
    reportError(error, { site: `${SITE}.record-standing`, extra: { kind } })
    throw error
  }

  const stamp = await supabase.from('manager_playbook')
    .update({ last_standing_run_at: plan.nowIso, updated_at: plan.nowIso })
    .eq('action_kind', kind)
  if (stamp.error) throw stamp.error
  return { recorded: !error }
}

export const gtmManagerStanding = inngest.createFunction(
  { id: 'cron-gtm-manager-standing', name: 'Cron: GTM Manager Standing Instructions', retries: 2 },
  // Half an hour after the morning brief, so the person has had the chance to read it first.
  { cron: '30 12 * * *' },  // 7:30am CT (UTC-5)
  async ({ step }) => {
    const plan = await step.run('plan', planStanding)
    for (const due of plan.due) {
      await step.run(`run-${due.kind}`, () => runStanding(due.kind, plan))
    }
    return { skip: plan.skip, ran: plan.due.map((d) => d.kind) }
  },
)
