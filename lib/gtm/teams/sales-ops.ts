import 'server-only'
import { unwrapList } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
import type { createServiceClient } from '@/lib/supabase/server'
import type { AgentTask } from '@/types/database'
import { VOICE_GUIDE_VERSION, checkDraft, type DraftText, type VoiceIssue } from '../brand/voice'
import { recordUsage, type JsonObject } from '../tasks'
import type { HandlerRegistry, TaskContext, TaskHandler, WorkOutcome } from '../worker'
import { generateDraft } from './sales-ops-draft'
import { INELIGIBLE_SUMMARY, draftEligibility } from './sales-ops-eligibility'
import type { DraftBrief } from './sales-ops-prompt'

/**
 * Sales Ops: drafts outreach emails for a person to review and send.
 *
 * It does not send, and it has no way to: nothing in this file or anything it
 * imports can contact a prospect. A draft is only a proposal in the approval
 * inbox. What leaves the company is a person copying approved text into their
 * own mailbox, and the guardrail in unit/guardrails/gtm-agent-boundaries.test.ts
 * fails the build if a sender is ever imported here.
 *
 * Every draft must pass checkDraft() (the voice rules) before anyone is asked to
 * read it. A draft that cannot be made to pass is a failed task with a visible
 * reason, never a rule quietly waived.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

export const SALES_OPS_TASK_TYPES = { draftOutreach: 'draft_outreach' } as const

const SITE = 'gtm.sales-ops'
const DAY_MS = 86_400_000
/** One try plus one correction. A draft that cannot pass in two is not worth a third call. */
export const MAX_DRAFT_ATTEMPTS = 2
const RECENT_TOUCHES_READ = 5
const FEEDBACK_NOTES_READ = 5

interface ProspectRow {
  id: string; company: string; city: string | null; state: string | null; pms: string | null
  portfolio_size: number | null; contact_name: string | null; contact_title: string | null
  status: string; email: string | null; email_status: string | null; last_touch_at: string | null
}

const PROSPECT_COLUMNS = 'id, company, city, state, pms, portfolio_size, contact_name, contact_title, status, email, email_status, last_touch_at'

export function firstNameOf(contactName: string | null): string | null {
  const first = contactName?.trim().split(/\s+/)[0] ?? ''
  // A single initial or a title is not a name to greet someone by.
  return first.length >= 2 && !first.endsWith('.') ? first : null
}

function daysAgo(iso: string | null, now: Date): number | null {
  return iso ? Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS)) : null
}

async function loadProspect(supabase: ServiceClient, id: string): Promise<ProspectRow | null> {
  const { data, error } = await supabase.from('prospect_accounts').select(PROSPECT_COLUMNS).eq('id', id).maybeSingle()
  if (error) {
    reportError(error, { site: `${SITE}.prospect`, extra: { prospectId: id } })
    throw error
  }
  return data as ProspectRow | null
}

async function loadRecentTouches(supabase: ServiceClient, id: string, now: Date) {
  const res = await supabase
    .from('prospect_touches')
    .select('touch_type, occurred_at')
    .eq('prospect_id', id)
    .order('occurred_at', { ascending: false })
    .limit(RECENT_TOUCHES_READ)
  const rows = unwrapList<{ touch_type: string; occurred_at: string }>(res, { site: `${SITE}.touches`, extra: { prospectId: id } })
  return rows.map((r) => ({ type: r.touch_type, daysAgo: daysAgo(r.occurred_at, now) ?? 0 }))
}

/** What the founder wrote when rejecting earlier drafts. The cheapest way to teach the voice. */
export async function loadRejectionFeedback(supabase: ServiceClient): Promise<string[]> {
  const res = await supabase
    .from('agent_tasks')
    .select('decision_note')
    .eq('team', 'sales_ops')
    .eq('task_type', SALES_OPS_TASK_TYPES.draftOutreach)
    .eq('status', 'rejected')
    .not('decision_note', 'is', null)
    .order('decided_at', { ascending: false })
    .limit(FEEDBACK_NOTES_READ)
  const rows = unwrapList<{ decision_note: string | null }>(res, { site: `${SITE}.feedback` })
  return rows.map((r) => r.decision_note?.trim() ?? '').filter(Boolean)
}

export function buildBrief(prospect: ProspectRow, touches: DraftBrief['priorTouches'], feedback: string[], now: Date): DraftBrief {
  const sent = touches.some((t) => ['emailed', 'called', 'texted', 'visited_no_contact'].includes(t.type))
  return {
    company:            prospect.company,
    city:               prospect.city,
    state:              prospect.state,
    pms:                prospect.pms,
    portfolioSize:      prospect.portfolio_size,
    contactFirstName:   firstNameOf(prospect.contact_name),
    contactTitle:       prospect.contact_title,
    kind:               sent || prospect.status !== 'queued' ? 'follow_up' : 'first_touch',
    daysSinceLastTouch: daysAgo(prospect.last_touch_at, now),
    priorTouches:       touches,
    feedback,
  }
}

function summarize(issues: readonly VoiceIssue[]): string {
  return [...new Set(issues.map((i) => i.rule))].join(', ')
}

/**
 * Asks for a draft, checks it, and on a miss asks once more with the exact
 * problems. Every call is billed before its text is judged, because the money is
 * spent whether or not the draft is any good.
 */
async function draftWithinVoice(
  task: AgentTask,
  ctx: TaskContext,
  brief: DraftBrief,
): Promise<DraftText & { attempts: number }> {
  let issues: VoiceIssue[] = []

  for (let attempt = 0; attempt < MAX_DRAFT_ATTEMPTS; attempt++) {
    const call = await generateDraft(brief, issues)
    await recordUsage(ctx.supabase, {
      team:         'sales_ops',
      taskId:       task.id,
      model:        call.model,
      inputTokens:  call.inputTokens,
      outputTokens: call.outputTokens,
      // Per task, per attempt of the task, per attempt within it: a retried step bills once.
      dedupeKey:    `sales_ops:draft:${task.id}:${task.attempts}:${attempt}`,
    })

    if (!call.draft) {
      issues = [{ rule: 'body_length', detail: 'You did not call the write_draft tool. Call it with a subject and a body.' }]
      continue
    }
    issues = checkDraft(call.draft, { firstName: brief.contactFirstName })
    if (issues.length === 0) return { ...call.draft, attempts: attempt + 1 }
  }
  throw new Error(`Draft failed the voice check after ${MAX_DRAFT_ATTEMPTS} tries: ${summarize(issues)}`)
}

function nothing(reason: string, summary: string): WorkOutcome {
  return { kind: 'nothing', output: { reason, summary } }
}

async function runDraft(task: AgentTask, ctx: TaskContext): Promise<WorkOutcome> {
  if (!task.prospect_id) return nothing('no_account', 'This task names no account.')

  const prospect = await loadProspect(ctx.supabase, task.prospect_id)
  if (!prospect) return nothing('account_not_found', 'The account no longer exists.')

  // Re-check the live row. The account can change between the report being approved and now.
  const eligible = draftEligibility(prospect)
  if (!eligible.ok) return nothing(eligible.reason, INELIGIBLE_SUMMARY[eligible.reason])

  const [touches, feedback] = await Promise.all([
    loadRecentTouches(ctx.supabase, prospect.id, ctx.now),
    loadRejectionFeedback(ctx.supabase),
  ])
  const brief = buildBrief(prospect, touches, feedback, ctx.now)
  const draft = await draftWithinVoice(task, ctx, brief)

  const recipient = brief.contactFirstName ? `${prospect.contact_name?.trim()}` : 'the contact'
  return { kind: 'propose', output: {
    subject:     draft.subject,
    body:        draft.body,
    summary:     `To ${recipient} at ${prospect.company}. Voice check passed (${VOICE_GUIDE_VERSION}). Review it, then send it from your own mailbox.`,
    voice_check: { passed: true, version: VOICE_GUIDE_VERSION, attempts: draft.attempts },
    kind:        brief.kind,
  } as JsonObject }
}

/**
 * No execute step, on purpose. Approving a draft means "this is good to send";
 * the sending is a person's, from their own mailbox, and they close the task by
 * telling the dashboard they sent it. A worker must never claim an approved
 * draft, which is why the registry has no execute here.
 */
export const draftOutreachHandler: TaskHandler = { run: runDraft }

export const salesOpsHandlers: HandlerRegistry = {
  [SALES_OPS_TASK_TYPES.draftOutreach]: draftOutreachHandler,
}
