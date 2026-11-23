import {
  ACTION_KINDS,
  ACTION_CATALOG,
  DEFAULT_CADENCE_DAYS,
  describeAction,
  standingDue,
  type ActionKind,
  type InstructionFacts,
  type InstructionRecord,
  type ProposedAction,
} from './instructions'

/**
 * When an instruction type is WARRANTED, as pure functions.
 *
 * Two ways a type can come due. A SCHEDULE type repeats on the rhythm a person's
 * own approvals showed (weekly by default), because nothing about the pipeline
 * says when it is needed. A CONDITION type is needed only when something is true
 * ("tasks have failed", "OwnerRez accounts are missing an email"), so it fires
 * when that is true and not before, and never more often than its minimum gap.
 *
 * The same conditions serve two readers, and that is the point of keeping them
 * here: the morning plan PROPOSES a warranted type a person has not yet handed
 * over, and a standing run EXECUTES a warranted type a person has handed over.
 * One definition of "this is warranted", so the plan and the autopilot cannot
 * disagree about what the pipeline needs.
 *
 * Deterministic on purpose, with no model: a trigger a person cannot predict is
 * one they cannot trust, and the facts it reads are counts the manager already
 * has. Every condition names the count it read, so a proposal can say why.
 */

export type Trigger =
  | { type: 'schedule' }
  | {
      type:        'condition'
      /** The least time between two firings, so a condition that stays true is not acted on every day. */
      minGapHours: number
      test:        (facts: InstructionFacts) => boolean
      /** Why it fired, in a sentence made of the counts that made it true. */
      reason:      (facts: InstructionFacts) => string
      /** Shown on the playbook, so a person can see what they would be handing over. */
      describe:    string
    }

function totalFailed(facts: InstructionFacts): number {
  return Object.values(facts.failedByTeam).reduce<number>((sum, n) => sum + (n ?? 0), 0)
}

/** Open Sales Ops drafts past this many mean the person has a pile to read already: more would only add to it. */
export const OPEN_SALES_OPS_CEILING = 5
/** Same for Lead Gen enrichment, which is also something to approve. */
export const OPEN_LEAD_GEN_CEILING = 10

export const TRIGGERS: Record<ActionKind, Trigger> = {
  requeue_failed: {
    type: 'condition', minGapHours: 24,
    test:     (f) => totalFailed(f) > 0,
    reason:   (f) => `${totalFailed(f)} ${totalFailed(f) === 1 ? 'task' : 'tasks'} failed in the last 7 days`,
    describe: 'when tasks have failed in the last 7 days, at most once a day',
  },
  redraft_rejected: {
    type: 'condition', minGapHours: 72,
    test:     (f) => f.rejectedDraftAccounts > 0 && f.openSalesOpsTasks < OPEN_SALES_OPS_CEILING,
    reason:   (f) => `${f.rejectedDraftAccounts} ${f.rejectedDraftAccounts === 1 ? 'account has' : 'accounts have'} a rejected draft and no new one`,
    describe: 'when accounts have a rejected draft and Sales Ops has fewer than 5 open tasks, at most every 3 days',
  },
  enrich_ownerrez: {
    type: 'condition', minGapHours: 48,
    test:     (f) => f.ownerrezNeedingContact > 0 && f.openLeadGenTasks < OPEN_LEAD_GEN_CEILING,
    reason:   (f) => `${f.ownerrezNeedingContact} OwnerRez ${f.ownerrezNeedingContact === 1 ? 'account has' : 'accounts have'} no email yet`,
    describe: 'when OwnerRez accounts have no email and Lead Gen has fewer than 10 open tasks, at most every 2 days',
  },
  // These two already have a weekly owner in the Rev Ops cron, so the morning plan does not propose them:
  // a person can still hand them to the manager, and then they repeat on the rhythm the person showed.
  run_funnel_report:        { type: 'schedule' },
  propose_queue_candidates: { type: 'schedule' },
}

/** The sentence the playbook shows for how a type comes due. */
export function describeTrigger(kind: ActionKind, cadenceDays: number): string {
  const trigger = TRIGGERS[kind]
  if (trigger.type === 'condition') return `Runs ${trigger.describe}.`
  return `Repeats about every ${cadenceDays} ${cadenceDays === 1 ? 'day' : 'days'}, the rhythm you showed.`
}

const HOUR_MS = 3_600_000

export interface FireInput {
  facts:       InstructionFacts
  now:         Date
  /** the last time this type ran or a person approved it, from any path */
  lastRunAt:   string | null
  cadenceDays: number
}

/** Whether a type is warranted right now. Never true for a condition type inside its minimum gap. */
export function triggerFires(kind: ActionKind, input: FireInput): boolean {
  const trigger = TRIGGERS[kind]
  if (trigger.type === 'schedule') {
    return standingDue({ now: input.now, lastRunAt: input.lastRunAt, cadenceDays: input.cadenceDays })
  }
  if (!trigger.test(input.facts)) return false
  if (!input.lastRunAt) return true
  return input.now.getTime() - new Date(input.lastRunAt).getTime() >= trigger.minGapHours * HOUR_MS
}

// ── the morning plan ────────────────────────────────────────────────────────

/** A type a person rejected in this many days is not proposed again: asking twice in a week is nagging. */
export const PLAN_REJECTION_COOLDOWN_DAYS = 7
/** The most one morning plan proposes. */
export const MAX_PLAN_ACTIONS = 3

const DAY_MS = 86_400_000

/** The types a person said no to recently, whether in reply to a plan or to their own instruction. */
export function recentlyRejectedKinds(records: readonly InstructionRecord[], now: Date): Set<ActionKind> {
  const since = now.getTime() - PLAN_REJECTION_COOLDOWN_DAYS * DAY_MS
  const out = new Set<ActionKind>()
  for (const r of records) {
    if (r.source === 'standing' || r.status !== 'rejected' || !r.decidedAt) continue
    if (new Date(r.decidedAt).getTime() < since) continue
    for (const kind of ACTION_KINDS) if (r.kinds.includes(kind)) out.add(kind)
  }
  return out
}

export interface PlanInput {
  facts:            InstructionFacts
  now:              Date
  /** per type, the last run or approval; a missing key reads as never */
  lastRunAt:        Partial<Record<ActionKind, string | null>>
  /** types a person has handed to the manager: they run on their own, so they are not proposed */
  granted:          ReadonlySet<ActionKind>
  recentlyRejected: ReadonlySet<ActionKind>
}

export interface Plan { actions: ProposedAction[]; reasons: string[] }

/**
 * What the manager would propose this morning: every CONDITION type that is
 * warranted, that a person has not already handed over, and that they did not
 * just say no to. Capped, so a plan is something to read in one sitting.
 */
export function buildPlan(input: PlanInput): Plan {
  const actions: ProposedAction[] = []
  const reasons: string[] = []
  for (const kind of ACTION_KINDS) {
    const trigger = TRIGGERS[kind]
    if (trigger.type !== 'condition') continue
    if (input.granted.has(kind) || input.recentlyRejected.has(kind)) continue
    const fires = triggerFires(kind, {
      facts: input.facts, now: input.now, lastRunAt: input.lastRunAt[kind] ?? null, cadenceDays: DEFAULT_CADENCE_DAYS,
    })
    if (!fires) continue
    actions.push({ kind, params: {}, summary: describeAction(kind, {}) })
    reasons.push(`${ACTION_CATALOG[kind].label}: ${trigger.reason(input.facts)}.`)
    if (actions.length >= MAX_PLAN_ACTIONS) break
  }
  return { actions, reasons }
}

/** The most standing runs the manager makes in one Central day, across every type. A ceiling on its own initiative. */
export const MANAGER_DAILY_ACTION_CAP = 6
