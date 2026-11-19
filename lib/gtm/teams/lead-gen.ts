import 'server-only'
import { normalizeWebsite } from '@/lib/prospecting/normalize'
import { reportError } from '@/lib/observability/report-error'
import type { AgentTask } from '@/types/database'
import type { JsonObject } from '../tasks'
import type { HandlerRegistry, TaskContext, TaskHandler, WorkOutcome } from '../worker'
import { applyApprovedContacts } from './lead-gen-apply'
import { buildEnrichmentOutcome, type ProspectContactState } from './lead-gen-proposal'
import { researchSite } from './lead-gen-fetch'

/**
 * Lead Gen: looks for public contact details on a prospect's own website and
 * PROPOSES them. It saves nothing. A person approves what it found, and only
 * then does lead-gen-apply.ts write it, into empty fields only.
 */

export const LEAD_GEN_TASK_TYPES = { enrichAccount: 'enrich_account' } as const

const SITE = 'gtm.lead-gen'

const PROSPECT_COLUMNS = 'id, company, website, domain, email, phone'

type ProspectRead = ProspectContactState & { website: string | null; domain: string | null }

/** The URL to read: the account's website if it has one, else its domain over https. */
export function siteUrlFor(prospect: Pick<ProspectRead, 'website' | 'domain'>): string | null {
  const candidate = prospect.website ?? (prospect.domain ? `https://${prospect.domain}` : null)
  if (!candidate) return null
  const url = normalizeWebsite(candidate)
  // safeFetch only speaks https, and a plain-http site would otherwise fail on every attempt.
  return url !== null && url.startsWith('https://') ? url : null
}

async function runEnrich(task: AgentTask, ctx: TaskContext): Promise<WorkOutcome> {
  if (!task.prospect_id) return { kind: 'nothing', output: { reason: 'no_account', summary: 'This task names no account.' } }

  const { data, error } = await ctx.supabase
    .from('prospect_accounts')
    .select(PROSPECT_COLUMNS)
    .eq('id', task.prospect_id)
    .maybeSingle()

  if (error) {
    reportError(error, { site: `${SITE}.read-prospect`, extra: { taskId: task.id } })
    throw error
  }
  if (!data) return { kind: 'nothing', output: { reason: 'account_not_found', summary: 'The account no longer exists.' } }

  const prospect = data as ProspectRead
  if (prospect.email && prospect.phone) {
    return { kind: 'nothing', output: { reason: 'already_has_contact', summary: 'The account already has an email and a phone number.' } }
  }

  const siteUrl = siteUrlFor(prospect)
  if (siteUrl === null) {
    return { kind: 'nothing', output: { reason: 'no_website', summary: 'The account has no website to read.' } }
  }

  const research = await researchSite(siteUrl)
  return buildEnrichmentOutcome(prospect, siteUrl, research)
}

/** Carrying out an approved proposal. Refuses unless a person's decision is on the task. */
async function executeEnrich(task: AgentTask, ctx: TaskContext): Promise<{ output: JsonObject }> {
  return { output: await applyApprovedContacts(ctx.supabase, task) }
}

/** Enrichment has an execute step (applying what a person approved), so it is typed as having one. */
export const enrichAccountHandler: Required<TaskHandler> = { run: runEnrich, execute: executeEnrich }

export const leadGenHandlers: HandlerRegistry = {
  [LEAD_GEN_TASK_TYPES.enrichAccount]: enrichAccountHandler,
}
