import { z } from 'zod'
import { isWorkerTeam, type WorkerTeam } from '../constants'

/**
 * Manager instructions as pure functions: what a reply to a brief is allowed to
 * ask for, how a model's reading of it is checked, and how the manager learns
 * which instruction types a person keeps approving.
 *
 * No database, no model, no network. Every decision that matters here (is this
 * action in the catalog, has a person approved this enough times to be asked,
 * is it due again) is one a test can pin exhaustively, and the code that acts on
 * them is deliberately thin.
 *
 * THE CATALOG IS THE CEILING. An instruction can only ever become one of these
 * actions, and every one of them does the same single thing: it puts a task on a
 * team's queue (or puts a failed task back on it). The queued task keeps its own
 * approval step, so even a manager acting on its own never contacts anyone and
 * never changes an account; a person still reads and approves whatever the
 * team produces. Adding an action here is the decision to let the manager do
 * that thing unattended once a person has granted it, so each one needs a
 * reason, and none may send, call, text, close or delete.
 */

export const ACTION_KINDS = ['requeue_failed', 'run_funnel_report', 'propose_queue_candidates'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === 'string' && (ACTION_KINDS as readonly string[]).includes(value)
}

interface CatalogEntry {
  label:       string
  /** Shown to the model and to the person: what this does, in one sentence. */
  description: string
  /** The one parameter any action takes: which team's failed tasks. Only requeue_failed. */
  takesTeam:   boolean
}

export const ACTION_CATALOG: Record<ActionKind, CatalogEntry> = {
  requeue_failed: {
    label:       'Retry failed tasks',
    description: 'Puts tasks that failed in the last 7 days back in their team\'s queue for another try. Optionally limited to one team.',
    takesTeam:   true,
  },
  run_funnel_report: {
    label:       'Write the funnel report',
    description: 'Asks Rev Ops for a funnel report now. It still waits for your approval before it hands anything to another team.',
    takesTeam:   false,
  },
  propose_queue_candidates: {
    label:       'Suggest accounts to queue',
    description: 'Asks Lead Gen to propose accounts that are ready for a first email. Nothing moves until you approve the list.',
    takesTeam:   false,
  },
}

export interface ActionParams { team?: WorkerTeam }

export interface ProposedAction {
  kind:    ActionKind
  params:  ActionParams
  /** Written by this code from the catalog, never by the model. */
  summary: string
}

const TEAM_NAMES: Record<WorkerTeam, string> = {
  lead_gen:      'Lead Gen',
  content_brand: 'Content & Brand',
  sales_ops:     'Sales Ops',
  rev_ops:       'Rev Ops',
}

export function describeAction(kind: ActionKind, params: ActionParams): string {
  const base = ACTION_CATALOG[kind].label
  return params.team ? `${base} (${TEAM_NAMES[params.team]} only)` : base
}

// ── reading the model's answer ──────────────────────────────────────────────

export const MAX_ACTIONS_PER_INSTRUCTION = 5
export const MAX_INSTRUCTION_CHARS = 1000
export const MIN_INSTRUCTION_CHARS = 3
const MAX_REPLY_CHARS = 600

const modelAnswer = z.object({
  reply:   z.string(),
  actions: z.array(z.object({
    kind: z.string(),
    team: z.string().nullish(),
  })),
})

export interface Interpretation {
  reply:   string
  actions: ProposedAction[]
}

/** The same rule as everywhere else customer-readable: copy never carries an em dash. */
function cleanReply(text: string): string {
  return text.replaceAll('—', ',').trim().slice(0, MAX_REPLY_CHARS)
}

/**
 * Turns whatever the model returned into an Interpretation, or null when it is
 * not even the right shape. The model's `kind` is checked against the catalog and
 * anything else is dropped (a model will invent an action that sounds right), its
 * team is checked against the real teams, repeats are collapsed, and the summary
 * is regenerated here so the words a person approves are ours, not the model's.
 */
export function readInterpretation(raw: unknown): Interpretation | null {
  const parsed = modelAnswer.safeParse(raw)
  if (!parsed.success) return null

  const seen = new Set<string>()
  const actions: ProposedAction[] = []
  for (const item of parsed.data.actions) {
    if (!isActionKind(item.kind)) continue
    const team = ACTION_CATALOG[item.kind].takesTeam && isWorkerTeam(item.team) ? item.team : undefined
    const params: ActionParams = team ? { team } : {}
    const key = `${item.kind}:${team ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    actions.push({ kind: item.kind, params, summary: describeAction(item.kind, params) })
    if (actions.length >= MAX_ACTIONS_PER_INSTRUCTION) break
  }
  return { reply: cleanReply(parsed.data.reply), actions }
}

/** What a stored proposal column holds, read back defensively: it is JSON a person approves from. */
export function readStoredProposal(value: unknown): ProposedAction[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): ProposedAction[] => {
    if (typeof item !== 'object' || item === null) return []
    const { kind, params } = item as { kind?: unknown; params?: unknown }
    if (!isActionKind(kind)) return []
    const teamRaw = typeof params === 'object' && params !== null ? (params as { team?: unknown }).team : undefined
    const team = ACTION_CATALOG[kind].takesTeam && isWorkerTeam(teamRaw) ? teamRaw : undefined
    const clean: ActionParams = team ? { team } : {}
    return [{ kind, params: clean, summary: describeAction(kind, clean) }]
  })
}

/** Strips control characters and trims, then checks the length. Returns the text or the reason. */
export function checkInstructionText(raw: unknown): { text: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'Write an instruction first.' }
  const text = raw.replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
  if (text.length < MIN_INSTRUCTION_CHARS) return { error: 'Write an instruction first.' }
  if (text.length > MAX_INSTRUCTION_CHARS) return { error: `Keep it under ${MAX_INSTRUCTION_CHARS} characters.` }
  return { text }
}

// ── learning what a person approves ─────────────────────────────────────────

/** A person has to have approved the same kind this many times, on this many different days, before the manager asks. */
export const STANDING_MIN_APPROVALS = 3
export const STANDING_MIN_DISTINCT_DAYS = 2
/** How often a standing action repeats when there is not yet enough history to see a rhythm. */
export const DEFAULT_CADENCE_DAYS = 7
export const MIN_CADENCE_DAYS = 1
export const MAX_CADENCE_DAYS = 14
/** A standing action holds back while this many tasks are already waiting on a person: it should not pile onto an unread inbox. */
export const STANDING_HOLD_AT_WAITING = 10

const DAY_MS = 86_400_000

export interface InstructionRecord {
  source:    'human' | 'standing'
  status:    string
  kinds:     readonly string[]
  decidedAt: string | null
}

export interface KindLearning {
  kind:           ActionKind
  /** instructions a person approved that included this kind */
  approved:       number
  rejected:       number
  distinctDays:   number
  lastApprovedAt: string | null
  /** the rhythm a person keeps, from the gaps between approvals; null until there are two */
  cadenceDays:    number | null
}

/** Approved means a person said yes, whatever happened when it ran. A reply the manager could not read is neither. */
const APPROVED_STATUSES = new Set(['applying', 'applied', 'failed'])

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function cadenceFrom(approvalTimes: readonly number[]): number | null {
  // Gaps between the days a person approved on, so three approvals in one
  // afternoon read as one day of evidence, not as "every few minutes".
  const days = [...new Set(approvalTimes.map((t) => Math.floor(t / DAY_MS)))].sort((a, b) => a - b)
  if (days.length < 2) return null
  const gaps = days.slice(1).map((d, i) => d - days[i])
  const rounded = Math.round(median([...gaps].sort((a, b) => a - b)))
  return Math.min(MAX_CADENCE_DAYS, Math.max(MIN_CADENCE_DAYS, rounded))
}

/** Only HUMAN instructions teach the manager anything: its own standing runs are not evidence about what a person wants. */
export function learnFromHistory(records: readonly InstructionRecord[]): KindLearning[] {
  return ACTION_KINDS.map((kind): KindLearning => {
    const mine = records.filter((r) => r.source === 'human' && r.kinds.includes(kind))
    const approvals = mine.filter((r) => APPROVED_STATUSES.has(r.status) && r.decidedAt !== null)
    const times = approvals.flatMap((r) => (r.decidedAt ? [new Date(r.decidedAt).getTime()] : []))
    return {
      kind,
      approved:       approvals.length,
      rejected:       mine.filter((r) => r.status === 'rejected').length,
      distinctDays:   new Set(times.map((t) => Math.floor(t / DAY_MS))).size,
      lastApprovedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      cadenceDays:    cadenceFrom(times),
    }
  })
}

/**
 * Whether the manager may OFFER to take a kind over. Conservative on purpose:
 * enough approvals on enough different days, and not one rejection, since a
 * person who has said no to this once has told it something the count hides.
 * This only makes the offer. Nothing runs on its own until a person says yes.
 */
export function mayOfferStanding(learning: KindLearning): boolean {
  return learning.approved >= STANDING_MIN_APPROVALS
    && learning.distinctDays >= STANDING_MIN_DISTINCT_DAYS
    && learning.rejected === 0
}

export function cadenceDaysFor(learning: KindLearning): number {
  return learning.cadenceDays ?? DEFAULT_CADENCE_DAYS
}

/** Whether a standing action has come round again. A kind that has never run is due. */
export function standingDue(input: { now: Date; lastRunAt: string | null; cadenceDays: number }): boolean {
  if (!input.lastRunAt) return true
  const elapsed = input.now.getTime() - new Date(input.lastRunAt).getTime()
  // An hour of slack, so a cron that fires a minute early on the due day does not wait a whole extra day.
  return elapsed >= input.cadenceDays * DAY_MS - 3_600_000
}

export function holdStanding(waitingForApproval: number): boolean {
  return waitingForApproval >= STANDING_HOLD_AT_WAITING
}

/** Row shape the history queries select, mapped to what the learning functions read. */
export interface InstructionHistoryRow {
  source:       string
  status:       string
  action_kinds: string[] | null
  decided_at:   string | null
}

export function recordsFromRows(rows: readonly InstructionHistoryRow[]): InstructionRecord[] {
  return rows.flatMap((r): InstructionRecord[] =>
    r.source === 'human' || r.source === 'standing'
      ? [{ source: r.source, status: r.status, kinds: r.action_kinds ?? [], decidedAt: r.decided_at }]
      : [])
}

/** The later of the last standing run and the last time a person approved this kind: the point the next one counts from. */
export function lastActivityAt(learning: KindLearning, lastStandingRunAt: string | null): string | null {
  const times = [learning.lastApprovedAt, lastStandingRunAt].flatMap((t) => (t ? [new Date(t).getTime()] : []))
  return times.length ? new Date(Math.max(...times)).toISOString() : null
}

/** How many history rows the learning looks at. A ceiling, not a page size: it is the most recent decisions that show the rhythm. */
export const INSTRUCTION_HISTORY_LIMIT = 500
