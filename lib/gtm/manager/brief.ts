import {
  TEAM_LABELS,
  WORKER_TEAMS,
  MANAGER_RUN_LABELS,
  type ManagerRunKind,
  type SettingsTeam,
  type WorkerTeam,
} from '../constants'
import { isTeamRunnable, settingFor, type TeamSetting } from '../policy'
import { openTaskCount, spentTodayCents, taskCount, type GtmRollup } from '../rollup'

/**
 * What the manager reads, and the facts it reports, with no model in the loop.
 *
 * The facts are assembled deterministically and are ALWAYS part of the brief.
 * A model may add a short narrative on top, but it never replaces them and is
 * never the source of a number: if the call fails, is switched off, or is over
 * budget, the brief is still complete and still correct. That ordering is the
 * point of observe-only mode: you are judging whether the manager's reading of
 * the pipeline is any good, which needs the readings kept apart from the prose.
 */

/** Stages that mean the account is finished, whichever way it went. */
const CLOSED_STAGES: readonly string[] = ['won', 'lost', 'disqualified']

export interface TeamQueueMetrics {
  team:          WorkerTeam
  open:          number
  pending:       number
  inProgress:    number
  needsApproval: number
  /** failed in the last 30 days */
  failed:        number
}

export interface TeamSpendMetrics {
  team:       SettingsTeam
  costCents:  number
  capCents:   number
  calls:      number
}

export interface ManagerMetrics {
  generatedAt:    string
  masterOn:       boolean
  managerOn:      boolean
  managerAutonomy: string
  funnelTotal:    number
  funnelActive:   number
  replied:        number
  meetingSet:     number
  inTrial:        number
  won:            number
  /** touches in the last 7 days, by type */
  touches7d:      Record<string, number>
  queue:          TeamQueueMetrics[]
  spend:          TeamSpendMetrics[]
  runningTeams:   WorkerTeam[]
  staleApprovals: number
  needsApproval:  number
}

function sum(values: Iterable<number>): number {
  let total = 0
  for (const v of values) total += v
  return total
}

export function buildMetrics(
  rollup: GtmRollup,
  settings: readonly TeamSetting[],
  now: Date,
): ManagerMetrics {
  const funnelActive = sum(
    Object.entries(rollup.funnel)
      .filter(([status]) => !CLOSED_STAGES.includes(status))
      .map(([, n]) => n),
  )

  const queue: TeamQueueMetrics[] = WORKER_TEAMS.map((team) => ({
    team,
    open:          openTaskCount(rollup, team),
    pending:       taskCount(rollup, team, 'pending'),
    inProgress:    taskCount(rollup, team, 'in_progress'),
    needsApproval: taskCount(rollup, team, 'needs_approval'),
    failed:        taskCount(rollup, team, 'failed'),
  }))

  const spend: TeamSpendMetrics[] = (['manager', ...WORKER_TEAMS] as const).map((team) => ({
    team,
    costCents: spentTodayCents(rollup, team),
    capCents:  settingFor(settings, team)?.daily_cost_cap_cents ?? 0,
    calls:     rollup.spend.find((s) => s.team === team)?.calls ?? 0,
  }))

  return {
    generatedAt:     now.toISOString(),
    masterOn:        settingFor(settings, 'global')?.enabled === true,
    managerOn:       isTeamRunnable(settings, 'manager'),
    managerAutonomy: settingFor(settings, 'manager')?.autonomy ?? 'propose_only',
    funnelTotal:     sum(Object.values(rollup.funnel)),
    funnelActive,
    replied:         rollup.funnel.replied     ?? 0,
    meetingSet:      rollup.funnel.meeting_set ?? 0,
    inTrial:         rollup.funnel.in_trial    ?? 0,
    won:             rollup.funnel.won         ?? 0,
    touches7d:       rollup.touches,
    queue,
    spend,
    runningTeams:    WORKER_TEAMS.filter((t) => isTeamRunnable(settings, t)),
    staleApprovals:  rollup.staleApprovals,
    needsApproval:   sum(queue.map((q) => q.needsApproval)),
  }
}

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`

function pipelineLine(m: ManagerMetrics): string {
  return `Pipeline: ${m.funnelTotal} accounts, ${m.funnelActive} still in play. `
    + `${m.replied} replied, ${m.meetingSet} meetings set, ${m.inTrial} in trial, ${m.won} won.`
}

function touchesLine(m: ManagerMetrics): string {
  const emailed = m.touches7d.emailed ?? 0
  const called  = m.touches7d.called ?? 0
  const texted  = m.touches7d.texted ?? 0
  const replied = m.touches7d.replied ?? 0
  const rate = emailed > 0 ? ` (${Math.round((replied / emailed) * 100)}% of emails)` : ''
  return `Last 7 days: ${emailed} emailed, ${called} called, ${texted} texted, ${replied} replies${rate}.`
}

function agentsLine(m: ManagerMetrics): string {
  if (!m.masterOn) return 'Agents: the master switch is off, so no team is running.'
  if (m.runningTeams.length === 0) return 'Agents: the master switch is on but no team is enabled.'
  const names = m.runningTeams.map((t) => TEAM_LABELS[t]).join(', ')
  return `Agents running: ${names}.`
}

function queueLine(q: TeamQueueMetrics): string {
  const parts = [`${q.open} open`]
  if (q.needsApproval > 0) parts.push(`${q.needsApproval} need approval`)
  if (q.failed > 0) parts.push(`${q.failed} failed in 30 days`)
  return `  ${TEAM_LABELS[q.team]}: ${parts.join(', ')}`
}

function spendLine(m: ManagerMetrics): string {
  const spent = sum(m.spend.map((s) => s.costCents))
  const cap   = sum(m.spend.map((s) => s.capCents))
  return `Spend today: ${usd(spent)} of ${usd(cap)} in daily caps.`
}

function needsYouLine(m: ManagerMetrics): string | null {
  if (m.needsApproval === 0) return null
  const stale = m.staleApprovals > 0 ? `, ${m.staleApprovals} waiting more than 48 hours` : ''
  return `Needs you: ${m.needsApproval} item${m.needsApproval === 1 ? '' : 's'} waiting for approval${stale}.`
}

/** The facts, one per line. Always present in the brief, model or no model. */
export function renderFacts(m: ManagerMetrics): string {
  const needsYou = needsYouLine(m)
  const lines = [
    pipelineLine(m),
    touchesLine(m),
    agentsLine(m),
    'Queue:',
    ...m.queue.map(queueLine),
    spendLine(m),
    ...(needsYou ? [needsYou] : []),
    m.managerAutonomy === 'propose_only'
      ? 'The manager is observe-only: it reports and proposes, and has created no tasks.'
      : 'The manager is in routing mode.',
  ]
  return lines.join('\n')
}

export function renderBrief(kind: ManagerRunKind, m: ManagerMetrics, narrative: string | null): string {
  const heading = `${MANAGER_RUN_LABELS[kind]}, ${m.generatedAt.slice(0, 10)}`
  return [heading, narrative, renderFacts(m)].filter((part): part is string => !!part).join('\n\n')
}

// ── the model's side of it ──────────────────────────────────────────────────

export const NARRATION_SYSTEM_PROMPT = [
  'You are the manager of FieldStay\'s go-to-market agent teams.',
  'You are given a JSON object of facts about the sales pipeline and the agent queues.',
  'Write a short brief for the founder in at most 110 words of plain prose, no lists, no headings.',
  'Say what matters most today, what needs a human decision, and one thing to focus on.',
  'Use only the numbers in the facts. Never invent or estimate a figure, a name or a cause.',
  'If the facts show nothing notable, say so in one sentence.',
  'Never use an em dash. Use commas or periods.',
].join(' ')

/** The facts a narrative is allowed to draw on. Counts only, never an account's contact details. */
export function narrationFacts(m: ManagerMetrics): Record<string, unknown> {
  return {
    master_switch_on:     m.masterOn,
    teams_running:        m.runningTeams,
    accounts_total:       m.funnelTotal,
    accounts_in_play:     m.funnelActive,
    replied:              m.replied,
    meetings_set:         m.meetingSet,
    in_trial:             m.inTrial,
    won:                  m.won,
    touches_last_7_days:  m.touches7d,
    queue:                m.queue,
    approvals_waiting:    m.needsApproval,
    approvals_over_48h:   m.staleApprovals,
    spend_today_cents:    Math.round(sum(m.spend.map((s) => s.costCents))),
  }
}

/** Narration is worth a model call only when someone has switched the manager on. */
export function mayNarrate(input: {
  managerRunnable: boolean
  spentCents:      number
  capCents:        number
  hasApiKey:       boolean
}): boolean {
  return input.managerRunnable && input.hasApiKey && input.spentCents < input.capCents
}
