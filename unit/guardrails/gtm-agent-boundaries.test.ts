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

/** Files allowed to write prospect rows. Empty today: no agent team writes the funnel yet. */
const PROSPECT_WRITERS = new Set<string>([])

/** The only agent files that may call a model. Each must bill it (see the pairing test). */
const LLM_CALLERS = new Set<string>(['lib/gtm/manager/narrate.ts'])

const PROSPECT_TABLE = /\.from\(\s*['"](prospect_accounts|prospect_contacts|prospect_touches)['"]\s*\)\s*\.(insert|update|upsert|delete)\b/
const PROSPECT_DELETE = /\.from\(\s*['"](prospect_accounts|prospect_contacts)['"]\s*\)\s*\.delete\b/
const CLOSED_STAGE_WRITE = /\bstatus\s*:\s*['"](won|lost|disqualified)['"]/
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

  it('no agent code deletes an account or sets a closed stage: won, lost and disqualified are a person\'s call', () => {
    expect(closedAccountViolations(sources)).toEqual([])
  })

  it('every model call is made from a file that is on the billed list', () => {
    expect(
      unbilledModelCallers(sources),
      'A model call outside LLM_CALLERS has no path to agent_usage, so a daily spend cap cannot see it.',
    ).toEqual([])
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

    it('an unbilled model caller', () => {
      expect(unbilledModelCallers(src(`import Anthropic from '@anthropic-ai/sdk'`))).toHaveLength(1)
      expect(unbilledModelCallers(src(`import { getAnthropicClient } from '@/lib/support/anthropic-client'`))).toHaveLength(1)
      expect(unbilledModelCallers([{ path: 'lib/gtm/manager/narrate.ts', code: `import { getAnthropicClient } from '@/lib/support/anthropic-client'` }])).toEqual([])
    })
  })
})
