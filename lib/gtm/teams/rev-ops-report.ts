import { formatCents } from '../format'

/**
 * The weekly funnel report, built from numbers with no model in the loop.
 *
 * Pure on purpose: every sentence is a function of the inputs, so a number in
 * the report can always be traced to a query, and a wrong report is a wrong
 * input rather than a mood. It reads like the manager's brief (facts, one per
 * line) because it is the same kind of document pointed at the funnel instead
 * of at the agents.
 */

/** Stages where we are in conversation or on the way to one: the ones that go cold if nobody follows up. */
export const ACTIVE_OUTREACH_STAGES = ['emailed', 'called', 'texted', 'replied', 'meeting_set', 'in_trial'] as const

/** An active account with no touch for this long is called out as stalled. */
export const STALE_TOUCH_DAYS = 7

/** How many accounts one approval can hand to Lead Gen. A pace, so one click cannot queue the whole backlog. */
export const MAX_LEAD_GEN_HANDOFFS = 10

/**
 * How many accounts one approval can hand to Sales Ops. Lower than Lead Gen's on
 * purpose: Lead Gen's results are a line to glance at, while every one of these is
 * a draft a person has to read and weigh against the voice. The pace is the reading,
 * not the machine.
 */
export const MAX_SALES_OPS_HANDOFFS = 5

export interface StaleExample { company: string; status: string; daysSinceTouch: number | null }

export interface ReportInput {
  now:              Date
  funnel:           Record<string, number>
  touchesThisWeek:  Record<string, number>
  touchesPriorWeek: Record<string, number>
  staleCount:       number
  staleExamples:    StaleExample[]
  needsContactInfo: number
  bouncedPrimary:   number
  queuedNoChannel:  number
  /** accounts Lead Gen could look for contact details on, best first */
  enrichCandidates: string[]
  /** accounts that have not answered and have an email, best first: Sales Ops could draft for them */
  draftCandidates:  string[]
  /** today's spend across every team, in cents */
  spendTodayCents:  number
}

export interface WeeklyReport {
  subject: string
  body:    string
  /** the figures behind the prose, so the report can be checked against a query */
  metrics: Record<string, number>
  /** what approving this report asks other teams to do */
  handoff: { lead_gen_enrich: string[]; sales_ops_draft: string[] }
}

const sum = (values: Iterable<number>): number => {
  let total = 0
  for (const v of values) total += v
  return total
}

function signed(n: number): string {
  if (n === 0) return 'no change'
  return n > 0 ? `+${n}` : String(n)
}

function replyRate(touches: Record<string, number>): number | null {
  const emailed = touches.emailed ?? 0
  return emailed > 0 ? Math.round(((touches.replied ?? 0) / emailed) * 100) : null
}

function rateLabel(rate: number | null): string {
  return rate === null ? 'no emails sent' : `${rate}%`
}

function activityLine(this_: Record<string, number>, prior: Record<string, number>): string {
  const kinds = ['emailed', 'called', 'texted', 'replied', 'meeting_set'] as const
  const parts = kinds.map((k) => `${this_[k] ?? 0} ${k.replace('_', ' ')} (${signed((this_[k] ?? 0) - (prior[k] ?? 0))})`)
  return `This week against last: ${parts.join(', ')}.`
}

function stalledLines(input: ReportInput): string[] {
  if (input.staleCount === 0) return [`Stalled: none. Every active account was touched in the last ${STALE_TOUCH_DAYS} days.`]
  const examples = input.staleExamples.map((e) => {
    const age = e.daysSinceTouch === null ? 'never touched' : `${e.daysSinceTouch}d`
    return `${e.company} (${e.status.replace('_', ' ')}, ${age})`
  })
  return [
    `Stalled: ${input.staleCount} active account${input.staleCount === 1 ? '' : 's'} with no touch in ${STALE_TOUCH_DAYS}+ days.`,
    ...(examples.length > 0 ? [`Longest waiting: ${examples.join('; ')}.`] : []),
  ]
}

function hygieneLine(input: ReportInput): string {
  return `Data hygiene: ${input.needsContactInfo} need contact info, ${input.bouncedPrimary} have a bounced primary email, `
    + `${input.queuedNoChannel} are queued with no email or phone.`
}

const plural = (n: number): string => (n === 1 ? 'account' : 'accounts')

function leadGenLine(count: number): string {
  return `Next step: approving this report asks Lead Gen to look for public contact details on ${count} `
    + `${plural(count)}. Each result still comes back here for approval before anything is saved.`
}

function salesOpsLine(count: number, first: boolean): string {
  return `${first ? 'Next step' : 'Also'}: approving it asks Sales Ops to draft a follow-up for ${count} ${plural(count)}. `
    + 'Drafts are for you to review and send yourself. Nothing is sent automatically.'
}

function nextStepLines(leadGen: number, salesOps: number): string[] {
  if (leadGen === 0 && salesOps === 0) return ['Next step: nothing to hand off. No account is missing contact details and has a website to read, and none is waiting on a follow-up.']
  return [
    ...(leadGen > 0 ? [leadGenLine(leadGen)] : []),
    ...(salesOps > 0 ? [salesOpsLine(salesOps, leadGen === 0)] : []),
  ]
}

export function weekLabel(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function buildWeeklyReport(input: ReportInput): WeeklyReport {
  const total = sum(Object.values(input.funnel))
  const closed = (input.funnel.won ?? 0) + (input.funnel.lost ?? 0) + (input.funnel.disqualified ?? 0)
  const handoff = input.enrichCandidates.slice(0, MAX_LEAD_GEN_HANDOFFS)
  const drafts = input.draftCandidates.slice(0, MAX_SALES_OPS_HANDOFFS)
  const rate = replyRate(input.touchesThisWeek)
  const priorRate = replyRate(input.touchesPriorWeek)

  const lines = [
    `Pipeline: ${total} accounts, ${total - closed} in play. ${input.funnel.replied ?? 0} replied, `
      + `${input.funnel.meeting_set ?? 0} meetings set, ${input.funnel.in_trial ?? 0} in trial, ${input.funnel.won ?? 0} won.`,
    activityLine(input.touchesThisWeek, input.touchesPriorWeek),
    `Reply rate (replies per email sent): ${rateLabel(rate)} this week, ${rateLabel(priorRate)} last week.`,
    ...stalledLines(input),
    hygieneLine(input),
    `Agent spend today: ${formatCents(input.spendTodayCents)}.`,
    ...nextStepLines(handoff.length, drafts.length),
  ]

  return {
    subject: `Weekly funnel report, week of ${weekLabel(input.now)}`,
    body:    lines.join('\n'),
    metrics: {
      accounts:           total,
      in_play:            total - closed,
      emailed_this_week:  input.touchesThisWeek.emailed ?? 0,
      emailed_last_week:  input.touchesPriorWeek.emailed ?? 0,
      replied_this_week:  input.touchesThisWeek.replied ?? 0,
      replied_last_week:  input.touchesPriorWeek.replied ?? 0,
      stalled:            input.staleCount,
      needs_contact_info: input.needsContactInfo,
      bounced_primary:    input.bouncedPrimary,
      queued_no_channel:  input.queuedNoChannel,
    },
    handoff: { lead_gen_enrich: handoff, sales_ops_draft: drafts },
  }
}

/** This week's touches minus the cumulative-since-14-days figure's overlap: the week before it. */
export function priorWeekTouches(since14: Record<string, number>, since7: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [kind, n] of Object.entries(since14)) out[kind] = Math.max(0, n - (since7[kind] ?? 0))
  return out
}
