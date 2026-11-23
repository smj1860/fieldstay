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

export const ACTION_KINDS = [
  'requeue_failed',
  'run_funnel_report',
  'propose_queue_candidates',
  'redraft_rejected',
  'enrich_ownerrez',
] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === 'string' && (ACTION_KINDS as readonly string[]).includes(value)
}

interface CatalogEntry {
  label:       string
  /** Shown to the model and to the person: what this does, in one sentence. */
  description: string
  /** Which team's failed tasks. Only requeue_failed. */
  takesTeam:   boolean
  /** How many accounts to take on, bounded by the executor. Only the two account-batch actions. */
  takesLimit:  boolean
}

export const ACTION_CATALOG: Record<ActionKind, CatalogEntry> = {
  requeue_failed: {
    label:       'Retry failed tasks',
    description: 'Puts tasks that failed in the last 7 days back in their team\'s queue for another try. Optionally limited to one team.',
    takesTeam:   true,
    takesLimit:  false,
  },
  run_funnel_report: {
    label:       'Write the funnel report',
    description: 'Asks Rev Ops for a funnel report now. It still waits for your approval before it hands anything to another team.',
    takesTeam:   false,
    takesLimit:  false,
  },
  propose_queue_candidates: {
    label:       'Suggest accounts to queue',
    description: 'Asks Lead Gen to propose accounts that are ready for a first email. Nothing moves until you approve the list.',
    takesTeam:   false,
    takesLimit:  false,
  },
  redraft_rejected: {
    label:       'Redraft rejected drafts',
    description: 'Asks Sales Ops to write a fresh draft for accounts whose draft you rejected in the last 30 days, using the notes you left on rejected drafts. Skips an account that has replied or already has a draft waiting. You still review every draft. At most 5 at a time.',
    takesTeam:   false,
    takesLimit:  true,
  },
  enrich_ownerrez: {
    label:       'Find contact details for OwnerRez accounts',
    description: 'Asks Lead Gen to read the public website of OwnerRez accounts that have no email yet, and propose contact details. You approve what gets saved. At most 10 at a time.',
    takesTeam:   false,
    takesLimit:  true,
  },
}

export interface ActionParams { team?: WorkerTeam; limit?: number }

/** The most one action may take on at once. Each account is something for a person to read or approve. */
export const ACCOUNT_BATCH_MAX: Record<'redraft_rejected' | 'enrich_ownerrez', number> = {
  redraft_rejected: 5,
  enrich_ownerrez:  10,
}

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
  if (params.team) return `${base} (${TEAM_NAMES[params.team]} only)`
  if (params.limit) return `${base} (up to ${params.limit})`
  return base
}

/** A requested count, clamped to what this action allows. Anything that is not a positive whole number means "the default". */
export function clampLimit(kind: ActionKind, raw: unknown): number | undefined {
  if (!ACTION_CATALOG[kind].takesLimit) return undefined
  const max = ACCOUNT_BATCH_MAX[kind as keyof typeof ACCOUNT_BATCH_MAX]
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return undefined
  return Math.min(raw, max)
}

/** The count an action actually takes: what was asked for within the ceiling, else the ceiling. */
export function effectiveLimit(kind: keyof typeof ACCOUNT_BATCH_MAX, params: ActionParams): number {
  return params.limit ?? ACCOUNT_BATCH_MAX[kind]
}

// ── reading the model's answer ──────────────────────────────────────────────

export const MAX_ACTIONS_PER_INSTRUCTION = 5
export const MAX_INSTRUCTION_CHARS = 1000
export const MIN_INSTRUCTION_CHARS = 3
const MAX_REPLY_CHARS = 600

const modelAnswer = z.object({
  reply:   z.string(),
  actions: z.array(z.object({
    kind:  z.string(),
    team:  z.string().nullish(),
    limit: z.number().nullish(),
  })),
  /** Parts of the request that are not on the list, in the person's own terms. Optional: an older answer has none. */
  unmet:   z.array(z.string()).nullish(),
})

export interface Interpretation {
  reply:   string
  actions: ProposedAction[]
  /** What was asked for that no action covers. Shown to the person, and the evidence for what to build next. */
  unmet:   string[]
}

export const MAX_UNMET = 5
export const MAX_UNMET_CHARS = 160

function cleanUnmet(raw: readonly string[] | null | undefined): string[] {
  return (raw ?? [])
    .map((u) => noEmDash(u).replaceAll(/\s+/g, ' ').trim().slice(0, MAX_UNMET_CHARS))
    .filter((u) => u.length > 0)
    .slice(0, MAX_UNMET)
}

/** A comma in place of the dash and the spaces around it, so "a — b" reads "a, b" and not "a , b". */
function noEmDash(text: string): string {
  return text.replaceAll(/\s*—\s*/g, ', ')
}

/** The same rule as everywhere else customer-readable: copy never carries an em dash. */
function cleanReply(text: string): string {
  return noEmDash(text).trim().slice(0, MAX_REPLY_CHARS)
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
    const limit = clampLimit(item.kind, item.limit)
    const params: ActionParams = { ...(team ? { team } : {}), ...(limit ? { limit } : {}) }
    const key = `${item.kind}:${team ?? ''}:${limit ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    actions.push({ kind: item.kind, params, summary: describeAction(item.kind, params) })
    if (actions.length >= MAX_ACTIONS_PER_INSTRUCTION) break
  }
  return { reply: cleanReply(parsed.data.reply), actions, unmet: cleanUnmet(parsed.data.unmet) }
}

/** What a stored proposal column holds, read back defensively: it is JSON a person approves from. */
export function readStoredProposal(value: unknown): ProposedAction[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): ProposedAction[] => {
    if (typeof item !== 'object' || item === null) return []
    const { kind, params } = item as { kind?: unknown; params?: unknown }
    if (!isActionKind(kind)) return []
    const raw = typeof params === 'object' && params !== null ? (params as { team?: unknown; limit?: unknown }) : {}
    const team = ACTION_CATALOG[kind].takesTeam && isWorkerTeam(raw.team) ? raw.team : undefined
    const limit = clampLimit(kind, raw.limit)
    const clean: ActionParams = { ...(team ? { team } : {}), ...(limit ? { limit } : {}) }
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

/**
 * Where an instruction row came from. 'human' is a person's own reply, 'manager'
 * is a plan the manager proposed for a person to approve, and 'standing' is the
 * manager repeating a type a person granted. A person's DECISION on a 'human' or
 * 'manager' row is evidence of what they want; a 'standing' run is the manager
 * acting and is evidence of nothing.
 */
export type InstructionSource = 'human' | 'manager' | 'standing'

export function isInstructionSource(value: unknown): value is InstructionSource {
  return value === 'human' || value === 'manager' || value === 'standing'
}

export interface InstructionRecord {
  source:    InstructionSource
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

/**
 * A person's decisions teach the manager: replies they wrote AND plans the manager
 * proposed that they approved or rejected (a rejection of its own plan is the
 * clearest "no" there is). Its own standing runs are not evidence about what a
 * person wants, so they never count.
 */
export function learnFromHistory(records: readonly InstructionRecord[]): KindLearning[] {
  return ACTION_KINDS.map((kind): KindLearning => {
    const mine = records.filter((r) => r.source !== 'standing' && r.kinds.includes(kind))
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
    isInstructionSource(r.source)
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

// ── what the manager can see when it reads a reply ──────────────────────────

/**
 * Live counts handed to the model with a reply, so a proposal can be specific
 * ("3 failed Lead Gen tasks") and "what would help most?" has an answer. COUNTS
 * ONLY, on purpose: no company, no contact, no draft text, no note a person
 * wrote. It is an allowlist, in the same spirit as narrationFacts().
 */
export interface InstructionFacts {
  failedByTeam:            Partial<Record<WorkerTeam, number>>
  /** accounts whose draft was rejected in the last 30 days and that have no draft waiting */
  rejectedDraftAccounts:   number
  /** OwnerRez accounts with no email yet and a site to read */
  ownerrezNeedingContact:  number
  waitingForApproval:      number
  /** open (queued, working, waiting or approved) tasks per team, so a batch is not piled onto an unfinished one */
  openLeadGenTasks:        number
  openSalesOpsTasks:       number
}

export function renderFacts(facts: InstructionFacts): string {
  const failed = Object.entries(facts.failedByTeam)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .map(([team, n]) => `${TEAM_NAMES[team as WorkerTeam]} ${n}`)
  return [
    'Current counts:',
    `- Failed tasks in the last 7 days: ${failed.length ? failed.join(', ') : 'none'}`,
    `- Accounts whose draft was rejected in the last 30 days and could be redrafted: ${facts.rejectedDraftAccounts}`,
    `- OwnerRez accounts with no email yet: ${facts.ownerrezNeedingContact}`,
    `- Items waiting for the person's approval: ${facts.waitingForApproval}`,
    `- Open Lead Gen tasks: ${facts.openLeadGenTasks}. Open Sales Ops tasks: ${facts.openSalesOpsTasks}`,
  ].join('\n')
}

// ── what people keep asking for that is not on the list ─────────────────────

export interface UnmetTally { request: string; count: number }

export const MAX_UNMET_SHOWN = 8

/**
 * Groups the "could not do" phrases from past replies, most-asked first. The
 * phrases are the manager's own wording of what a person asked for, so two
 * replies that mean the same thing rarely match exactly: this counts only
 * repeats of the same words (case and spacing aside), which under-counts and
 * never over-counts. The list is a prompt for what to build next, not a statistic.
 */
export function tallyUnmet(rows: readonly (readonly string[])[]): UnmetTally[] {
  const byKey = new Map<string, UnmetTally>()
  for (const phrases of rows) {
    for (const phrase of phrases) {
      const key = phrase.toLowerCase().replaceAll(/\s+/g, ' ').trim()
      if (!key) continue
      const seen = byKey.get(key)
      if (seen) seen.count += 1
      else byKey.set(key, { request: phrase.trim(), count: 1 })
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.request.localeCompare(b.request)).slice(0, MAX_UNMET_SHOWN)
}
