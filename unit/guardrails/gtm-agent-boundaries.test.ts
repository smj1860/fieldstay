import { describe, it, expect } from 'vitest'
import { collectSourceFiles, readCode, rel } from './scan'

// ============================================================================
// The GTM agents' boundaries, as structure rather than as a promise.
//
// The design says three things in prose: an agent never sends anything to a
// person outside the company, never closes or deletes an account (a person does
// that), and never spends model tokens the ledger does not see. Prose is read
// once and forgotten; each of these is a few lines of source that a later
// "just this once" change could add without anyone noticing, so each is scanned
// for here. A new team that genuinely needs one of these capabilities adds its
// file to the matching allowlist below, with a reason, in the same change.
//
// "Agent code" is lib/gtm/** and lib/inngest/functions/gtm-*.ts. The Server
// Actions a PERSON clicks (app/admin/prospects/agents-actions.ts) are
// deliberately out of scope: they are the human side of every one of these rules.
// ============================================================================

const AGENT_FILES = [
  ...collectSourceFiles(['lib/gtm']),
  ...collectSourceFiles(['lib/inngest/functions']).filter((f) => /\/gtm-[^/]+\.tsx?$/.test(f)),
]

/** Modules and strings whose presence means "this code can contact a person". */
const OUTBOUND_SEND = [
  /from\s+['"]@\/lib\/sms\b/,
  /from\s+['"]@\/lib\/resend\b/,
  /from\s+['"]resend['"]/,
  /api\.telnyx\.com/,
  /\bsendSMS\s*\(/,
]

/**
 * Files allowed to write prospect rows. Exactly one: applying a proposal a person
 * approved. Lead Gen PROPOSES contact details and this file saves them, into
 * empty fields only, after the approval. A team that needs to write the funnel
 * adds its file here with the reason, in the same change.
 */
const PROSPECT_WRITERS = new Set<string>(['lib/gtm/teams/lead-gen-apply.ts'])

/** The only agent files that may call a model. Each must bill it (see the pairing test). */
const LLM_CALLERS = new Set<string>(['lib/gtm/manager/narrate.ts', 'lib/gtm/teams/sales-ops-draft.ts'])

const PROSPECT_TABLE = /\.from\(\s*['"](prospect_accounts|prospect_contacts|prospect_touches)['"]\s*\)\s*\.(insert|update|upsert|delete)\b/
const PROSPECT_DELETE = /\.from\(\s*['"](prospect_accounts|prospect_contacts)['"]\s*\)\s*\.delete\b/
const CLOSED_STAGE_WRITE = /\bstatus\s*:\s*['"](won|lost|disqualified)['"]/
/** A raw fetch() on a URL that came from a database row is an SSRF hole; agents use safeFetch(). */
const BARE_FETCH = /(?<![\w$.])fetch\s*\(/
const LLM_IMPORT = /from\s+['"](@anthropic-ai\/sdk|@\/lib\/support\/anthropic-client)['"]/

interface Source { path: string; code: string }

function outboundSendViolations(files: readonly Source[]): string[] {
  return files.filter((f) => OUTBOUND_SEND.some((re) => re.test(f.code))).map((f) => f.path)
}

function prospectWriteViolations(files: readonly Source[]): string[] {
  return files.filter((f) => !PROSPECT_WRITERS.has(f.path) && PROSPECT_TABLE.test(f.code)).map((f) => f.path)
}

function closedAccountViolations(files: readonly Source[]): string[] {
  return files.filter((f) => PROSPECT_DELETE.test(f.code) || CLOSED_STAGE_WRITE.test(f.code)).map((f) => f.path)
}

function bareFetchViolations(files: readonly Source[]): string[] {
  return files.filter((f) => BARE_FETCH.test(f.code)).map((f) => f.path)
}

/** What the one prospect writer must contain, and must not. Each is a rule from its own header comment. */
function applyWriterViolations(code: string): string[] {
  const problems: string[] = []
  if (!/\.decided_at\b/.test(code)) problems.push('does not check that a person decided')
  if (!/\.is\(\s*column\s*,\s*null\s*\)/.test(code)) problems.push('does not fill only empty fields')
  if (/\bstatus\s*:/.test(code)) problems.push('names a status')
  if (/\.delete\s*\(/.test(code)) problems.push('deletes')
  return problems
}

/**
 * Sales Ops' promises about its own drafts, as code: whatever the model returns
 * passes checkDraft() before anyone is asked to read it, it is billed, and the
 * draft handler has no `execute` step, so a worker can never "finish" an approved
 * draft by doing something with it. Approval means "good to send"; sending is a
 * person's, from their own mailbox.
 */
function draftHandlerViolations(code: string): string[] {
  const problems: string[] = []
  if (!/\bgenerateDraft\(/.test(code)) problems.push('does not call the drafting model')
  if (!/\bcheckDraft\(/.test(code)) problems.push('never checks the draft against the voice')
  if (!/\brecordUsage\(/.test(code)) problems.push('does not bill the model call')
  if (/\bexecute\s*:/.test(code)) problems.push('has an execute step, so a worker would act on an approved draft')
  return problems
}

/**
 * Sales Ops' promises about its call briefs, as code: a brief is built from facts
 * by the pure builder, no model writes it (so nothing is invented about a
 * stranger's business), and the handler has no `execute` step, so a worker can
 * never act on an approved brief. The call itself is a person on their own phone.
 */
function callBriefViolations(code: string): string[] {
  const problems: string[] = []
  if (!/\bbuildCallBrief\(/.test(code)) problems.push('does not build the brief with the pure builder')
  if (LLM_IMPORT.test(code) || /\bgenerateDraft\(/.test(code)) problems.push('calls a model: a brief is built from facts, not generated')
  if (/\bexecute\s*:/.test(code)) problems.push('has an execute step, so a worker would act on an approved brief')
  return problems
}

/** The builder stays pure: no database, no network, no queue, nothing that could reach a person. */
function briefBuilderViolations(code: string): string[] {
  const problems: string[] = []
  if (/\bsupabase\b|\binngest\b|@\/lib\/sms|@\/lib\/resend/i.test(code)) problems.push('reaches a database, a queue or a sender')
  if (BARE_FETCH.test(code)) problems.push('makes a network call')
  if (LLM_IMPORT.test(code)) problems.push('imports a model client')
  return problems
}

function unbilledModelCallers(files: readonly Source[]): string[] {
  return files.filter((f) => LLM_IMPORT.test(f.code) && !LLM_CALLERS.has(f.path)).map((f) => f.path)
}

const sources: Source[] = AGENT_FILES.map((f) => ({ path: rel(f), code: readCode(f) }))

describe('guardrail: GTM agent boundaries', () => {
  it('scans a real set of agent files (a scan of nothing proves nothing)', () => {
    const paths = sources.map((s) => s.path)
    expect(paths).toContain('lib/gtm/tasks.ts')
    expect(paths).toContain('lib/inngest/functions/gtm-manager.ts')
    expect(paths).toContain('lib/inngest/functions/gtm-stall-sweep.ts')
  })

  it('no agent code can contact a person: no email, SMS or Telnyx path is imported', () => {
    expect(
      outboundSendViolations(sources),
      'Agents propose; a person approves; only then does anything go out, through the existing send paths and their gates. ' +
      'Importing a sender here lets an agent skip the approval inbox.',
    ).toEqual([])
  })

  it('no agent code writes the prospect tables, until a team is given that job on purpose', () => {
    expect(
      prospectWriteViolations(sources),
      'A team that needs to write the funnel adds its file to PROSPECT_WRITERS with the reason, in the same change.',
    ).toEqual([])
  })

  it('only the approved-proposal applier writes prospects, and it is held to its own rules', () => {
    const writers = sources.filter((x) => PROSPECT_TABLE.test(x.code)).map((x) => x.path)
    expect(writers).toEqual(['lib/gtm/teams/lead-gen-apply.ts'])
    const apply = sources.find((x) => x.path === 'lib/gtm/teams/lead-gen-apply.ts')!
    expect(applyWriterViolations(apply.code)).toEqual([])
  })

  it('no agent code calls a bare fetch(): URLs from the database go through safeFetch()', () => {
    expect(bareFetchViolations(sources)).toEqual([])
  })

  it('no agent code deletes an account or sets a closed stage: won, lost and disqualified are a person\'s call', () => {
    expect(closedAccountViolations(sources)).toEqual([])
  })

  it('every model call is made from a file that is on the billed list', () => {
    expect(
      unbilledModelCallers(sources),
      'A model call outside LLM_CALLERS has no path to agent_usage, so a daily spend cap cannot see it.',
    ).toEqual([])
  })

  it('the Sales Ops draft handler checks the voice, bills the call, and has no execute step', () => {
    const handler = sources.find((x) => x.path === 'lib/gtm/teams/sales-ops.ts')
    expect(handler, 'lib/gtm/teams/sales-ops.ts should be scanned').toBeDefined()
    expect(draftHandlerViolations(handler!.code)).toEqual([])
  })

  it('the Sales Ops call brief is built from facts, never generated, and a worker never acts on one', () => {
    const handler = sources.find((x) => x.path === 'lib/gtm/teams/sales-ops-calls.ts')
    expect(handler, 'lib/gtm/teams/sales-ops-calls.ts should be scanned').toBeDefined()
    expect(callBriefViolations(handler!.code)).toEqual([])
    const builder = sources.find((x) => x.path === 'lib/gtm/teams/sales-ops-call-brief.ts')
    expect(builder, 'lib/gtm/teams/sales-ops-call-brief.ts should be scanned').toBeDefined()
    expect(briefBuilderViolations(builder!.code)).toEqual([])
  })

  it('every function that triggers a model call also records its usage', () => {
    const manager = sources.find((s) => s.path === 'lib/inngest/functions/gtm-manager.ts')!
    expect(manager.code).toContain('narrateBrief(')
    expect(manager.code).toContain('recordUsage(')
  })

  // A scan that passes because it is broken looks exactly like one that passes
  // because the tree is clean, so each rule is shown to FIRE on a violation and
  // to stay quiet on a control.
  describe('fire-checks: each rule catches a violation and ignores a clean control', () => {
    const src = (code: string): Source[] => [{ path: 'lib/gtm/fixture.ts', code }]

    it('outbound send', () => {
      expect(outboundSendViolations(src(`import { sendSMS } from '@/lib/sms/telnyx'`))).toHaveLength(1)
      expect(outboundSendViolations(src(`import { Resend } from 'resend'`))).toHaveLength(1)
      expect(outboundSendViolations(src(`fetch('https://api.telnyx.com/v2/messages')`))).toHaveLength(1)
      expect(outboundSendViolations(src(`import { reportError } from '@/lib/observability/report-error'`))).toEqual([])
    })

    it('prospect writes, whatever the whitespace', () => {
      expect(prospectWriteViolations(src(`await supabase.from('prospect_accounts').update({ notes: 'x' })`))).toHaveLength(1)
      expect(prospectWriteViolations(src(`await supabase\n  .from("prospect_contacts")\n  .insert({})`))).toHaveLength(1)
      expect(prospectWriteViolations(src(`await supabase.from('prospect_accounts').select('id')`))).toEqual([])
      expect(prospectWriteViolations(src(`await supabase.from('agent_tasks').update({})`))).toEqual([])
    })

    it('closing or deleting an account', () => {
      expect(closedAccountViolations(src(`supabase.from('prospect_accounts').delete().eq('id', id)`))).toHaveLength(1)
      expect(closedAccountViolations(src(`update({ status: 'won' })`))).toHaveLength(1)
      expect(closedAccountViolations(src(`update({ status: "disqualified" })`))).toHaveLength(1)
      // Reading the closed stages to count them is fine: no `status:` assignment.
      expect(closedAccountViolations(src(`const CLOSED = ['won', 'lost', 'disqualified']`))).toEqual([])
      expect(closedAccountViolations(src(`update({ status: 'emailed' })`))).toEqual([])
    })

    it('a bare fetch, but not safeFetch or a method named fetch', () => {
      expect(bareFetchViolations(src(`const r = await fetch(url)`))).toHaveLength(1)
      expect(bareFetchViolations(src(`const r = await safeFetch(url)`))).toEqual([])
      expect(bareFetchViolations(src(`await client.fetch(url)`))).toEqual([])
    })

    it('the applier rules: no decision check, no empty-only fill, a status, a delete', () => {
      const good = `if (!task.decided_at) throw 1; await q.update(p).is(column, null)`
      expect(applyWriterViolations(good)).toEqual([])
      expect(applyWriterViolations(`await q.update(p).is(column, null)`)).toContain('does not check that a person decided')
      expect(applyWriterViolations(`task.decided_at; await q.update(p)`)).toContain('does not fill only empty fields')
      expect(applyWriterViolations(`${good}; update({ status: 'emailed' })`)).toContain('names a status')
      expect(applyWriterViolations(`${good}; q.delete()`)).toContain('deletes')
    })

    it('the draft handler rules', () => {
      const good = `const c = await generateDraft(b); await recordUsage(s, u); const i = checkDraft(c.draft); export const h = { run }`
      expect(draftHandlerViolations(good)).toEqual([])
      expect(draftHandlerViolations(good.replace('checkDraft(', 'skip('))).toContain('never checks the draft against the voice')
      expect(draftHandlerViolations(good.replace('recordUsage(', 'skip('))).toContain('does not bill the model call')
      expect(draftHandlerViolations(good.replace('generateDraft(', 'skip('))).toContain('does not call the drafting model')
      expect(draftHandlerViolations(`${good.replace('{ run }', '{ run, execute: send }')}`)).toContain('has an execute step, so a worker would act on an approved draft')
    })

    it('the call brief rules', () => {
      const good = `const b = buildCallBrief(facts); export const h = { run }`
      expect(callBriefViolations(good)).toEqual([])
      expect(callBriefViolations(`const b = 1`)).toContain('does not build the brief with the pure builder')
      expect(callBriefViolations(`${good}; await generateDraft(x)`)).toContain('calls a model: a brief is built from facts, not generated')
      expect(callBriefViolations(`${good}; import Anthropic from '@anthropic-ai/sdk'`)).toContain('calls a model: a brief is built from facts, not generated')
      expect(callBriefViolations(good.replace('{ run }', '{ run, execute: dial }'))).toContain('has an execute step, so a worker would act on an approved brief')
    })

    it('the brief builder stays pure', () => {
      expect(briefBuilderViolations(`export const buildCallBrief = () => 1`)).toEqual([])
      expect(briefBuilderViolations(`await supabase.from('x')`)).toContain('reaches a database, a queue or a sender')
      expect(briefBuilderViolations(`import { sendSMS } from '@/lib/sms/telnyx'`)).toContain('reaches a database, a queue or a sender')
      expect(briefBuilderViolations(`await fetch(u)`)).toContain('makes a network call')
      expect(briefBuilderViolations(`import { getAnthropicClient } from '@/lib/support/anthropic-client'`)).toContain('imports a model client')
    })

    it('an unbilled model caller', () => {
      expect(unbilledModelCallers(src(`import Anthropic from '@anthropic-ai/sdk'`))).toHaveLength(1)
      expect(unbilledModelCallers(src(`import { getAnthropicClient } from '@/lib/support/anthropic-client'`))).toHaveLength(1)
      expect(unbilledModelCallers([{ path: 'lib/gtm/manager/narrate.ts', code: `import { getAnthropicClient } from '@/lib/support/anthropic-client'` }])).toEqual([])
    })
  })
})
