import 'server-only'
import { unwrapList } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
import type { createServiceClient } from '@/lib/supabase/server'
import type { AgentTask } from '@/types/database'
import { VOICE_GUIDE_VERSION } from '../brand/voice'
import type { JsonObject } from '../tasks'
import type { TaskContext, TaskHandler, WorkOutcome } from '../worker'
import { buildCallBrief, type CallBriefFacts } from './sales-ops-call-brief'

/**
 * Sales Ops: prepares a call brief for a person to read before phoning a
 * property manager.
 *
 * It places no call and cannot: nothing in this file or anything it imports can
 * dial, and it carries no `execute` step, so a worker never claims an approved
 * brief. It also calls no model. The brief is built from facts the account
 * already holds, as guesses worded to be asked rather than claims to be made
 * (see sales-ops-call-brief.ts for why).
 *
 * Unlike a drafted email, a brief is useful at ANY open stage, including an
 * account that has replied: a person about to call someone mid-conversation
 * needs it more, not less. Only a closed account gets nothing.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

export const CALL_BRIEF_TASK_TYPE = 'call_brief'

const SITE = 'gtm.sales-ops.calls'
const DAY_MS = 86_400_000
const RECENT_TOUCHES_READ = 5
const CLOSED_STAGES: ReadonlySet<string> = new Set(['won', 'lost', 'disqualified'])

interface CallProspectRow {
  id: string; company: string; city: string | null; state: string | null; market: string | null
  pms: string | null; pms_note: string | null; portfolio_size: number | null
  contact_name: string | null; contact_title: string | null
  email_is_generic: boolean; phone: string | null; source: string | null
  status: string; notes: string | null; status_note: string | null
}

const CALL_COLUMNS = 'id, company, city, state, market, pms, pms_note, portfolio_size, contact_name, contact_title, email_is_generic, phone, source, status, notes, status_note'

async function loadProspect(supabase: ServiceClient, id: string): Promise<CallProspectRow | null> {
  const { data, error } = await supabase.from('prospect_accounts').select(CALL_COLUMNS).eq('id', id).maybeSingle()
  if (error) {
    reportError(error, { site: `${SITE}.prospect`, extra: { prospectId: id } })
    throw error
  }
  return data as CallProspectRow | null
}

async function loadTouches(supabase: ServiceClient, id: string, now: Date) {
  const res = await supabase
    .from('prospect_touches')
    .select('touch_type, occurred_at')
    .eq('prospect_id', id)
    .order('occurred_at', { ascending: false })
    .limit(RECENT_TOUCHES_READ)
  const rows = unwrapList<{ touch_type: string; occurred_at: string }>(res, { site: `${SITE}.touches`, extra: { prospectId: id } })
  return rows.map((r) => ({
    type:    r.touch_type,
    daysAgo: Math.max(0, Math.floor((now.getTime() - new Date(r.occurred_at).getTime()) / DAY_MS)),
  }))
}

function joinNotes(row: CallProspectRow): string | null {
  const parts = [row.notes, row.status_note].map((n) => n?.trim() ?? '').filter(Boolean)
  return parts.length > 0 ? parts.join(' / ') : null
}

export function factsFrom(row: CallProspectRow, touches: CallBriefFacts['priorTouches']): CallBriefFacts {
  return {
    company:        row.company,
    city:           row.city,
    state:          row.state,
    market:         row.market,
    pms:            row.pms,
    pmsNote:        row.pms_note,
    portfolioSize:  row.portfolio_size,
    contactName:    row.contact_name,
    contactTitle:   row.contact_title,
    emailIsGeneric: row.email_is_generic,
    hasPhone:       row.phone !== null && row.phone.trim() !== '',
    source:         row.source,
    status:         row.status,
    founderNotes:   joinNotes(row),
    priorTouches:   touches,
  }
}

function nothing(reason: string, summary: string): WorkOutcome {
  return { kind: 'nothing', output: { reason, summary } }
}

async function runCallBrief(task: AgentTask, ctx: TaskContext): Promise<WorkOutcome> {
  if (!task.prospect_id) return nothing('no_account', 'This task names no account.')

  const prospect = await loadProspect(ctx.supabase, task.prospect_id)
  if (!prospect) return nothing('account_not_found', 'The account no longer exists.')
  if (CLOSED_STAGES.has(prospect.status)) return nothing('closed', 'The account is closed, so no call brief was prepared.')

  const touches = await loadTouches(ctx.supabase, prospect.id, ctx.now)
  const brief = buildCallBrief(factsFrom(prospect, touches))

  const who = prospect.contact_name?.trim() || 'the contact'
  return { kind: 'propose', output: {
    // `subject` and `body` are the keys the inbox and the panels already render.
    subject:    brief.headline,
    body:       brief.text,
    summary:    `For a call to ${who} at ${prospect.company}. ${brief.hypotheses.length} guesses to ask about, ${brief.unknown.length} things we do not know. You place the call yourself.`,
    guesses:    brief.hypotheses.map((h) => h.id),
    guide:      { version: VOICE_GUIDE_VERSION },
    has_phone:  prospect.phone !== null && prospect.phone.trim() !== '',
  } as JsonObject }
}

/**
 * No execute step, on purpose. Approving a brief means "worth using"; the call is
 * a person's, from their own phone, and they close the task by saying they made
 * it. A worker must never claim an approved brief.
 */
export const callBriefHandler: TaskHandler = { run: runCallBrief }
