import { describe, it, expect } from 'vitest'
import { blankNonCode, collectSourceFiles, read, readBlanked, rel } from './scan'

// ============================================================================
// Inngest step tooling may not be nested inside another step's callback.
//
// The SDK detects this and emits a NESTING_STEPS warning — it WARNS, it does
// not throw (inngest/components/execution/v1.js: "we'll only show a warning
// here"). That is why two of these survived review and shipped.
//
// What it costs at runtime, which the warning does not say: a step tool called
// mid-callback registers a new step op and the request unwinds so the server
// can schedule it, leaving the ENCLOSING step.run unresolved. On the next pass
// the nested op is memoized but the outer step is not, so its callback runs
// again from the top. Both offending sites ran `logAuditEvent(...)` — a plain
// insert, no dedup key — before the nested send, so every OwnerRez connection
// error wrote TWO `integration.sync_failed` audit rows.
//
// Two shapes are checked, because only the first one is obvious:
//
//   1. DIRECT   — step.sendEvent(...) written inside a step.run(...) body.
//   2. INDIRECT — a helper defined in the same file that calls step.*, invoked
//                 from inside a step.run body. This is how ownerrez-reviews-
//                 sync.ts hid its nesting: a `notifyRevokedThrottled()` helper
//                 closed over `step`, so a lexical scan for step.* inside
//                 step.run found nothing. A scanner that only does (1) reports
//                 this file as clean.
//
// The fix is always the same shape: the step.run returns a DECISION, and the
// step tooling happens at the top level of the function. See
// lib/integrations/connection-error-notify.ts for the worked example.
// ============================================================================

const STEP_TOOLS = 'run|sendEvent|sleep|sleepUntil|waitForEvent|invoke'
const STEP_CALL  = new RegExp(String.raw`\bstep\.(${STEP_TOOLS})\s*\(`, 'g')

// Blanking comments AND literal bodies is not optional here. An early version
// of this scan (written by hand while fixing the two real sites) flagged
// ical-sync.ts, whose only offence was a COMMENT reading "Inngest serializes
// step.run() results as JSON". Guarding a rule with a checker that flags the
// prose explaining the rule is a mistake this repo has now made four times.
//
// `blankNonCode` used to be a local copy, and the copy did not know what a
// regex literal was: a character class containing a quote opened a "string"
// that ran to the next matching quote — which in lib/utils/html.ts meant the
// scanner stopped seeing the file at `/[&<>"']/` and treated the remaining
// two thirds as string body. A step-nesting violation living after any such
// regex was simply invisible. It now shares the lexer in ./scan, which
// tracks regex literals; see scan-strip-comments.test.ts for the fixture.

/** Index of the bracket matching the one at `open` (must be ( or {). */
function matchBracket(src: string, open: number): number {
  const closeOf: Record<string, string> = { '(': ')', '{': '}' }
  const o = src[open]
  const c = closeOf[o]
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++
    else if (src[i] === c) {
      depth--
      if (depth === 0) return i
    }
  }
  return src.length
}

const lineAt = (src: string, idx: number) => src.slice(0, idx).split('\n').length

interface StepCall { start: number; open: number; end: number; tool: string }

function stepCalls(code: string): StepCall[] {
  const calls: StepCall[] = []
  for (const m of code.matchAll(STEP_CALL)) {
    const open = code.indexOf('(', m.index!)
    calls.push({ start: m.index!, open, end: matchBracket(code, open), tool: m[1] })
  }
  return calls
}

/** Names of functions declared in this file whose body calls step.* tooling. */
function stepUsingHelpers(code: string): string[] {
  const names: string[] = []
  const decl = /(?:async\s+function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*async\s*(?:\(|function))/g
  for (const m of code.matchAll(decl)) {
    const name = m[1] ?? m[2]
    const brace = code.indexOf('{', m.index! + m[0].length - 1)
    if (brace < 0) continue
    const body = code.slice(brace, matchBracket(code, brace))
    if (new RegExp(String.raw`\bstep\.(${STEP_TOOLS})\s*\(`).test(body)) names.push(name)
  }
  return names
}

/** (1) DIRECT: another step call lexically inside a step.run's argument list. */
function directNesting(file: string, src: string, calls: StepCall[], runs: StepCall[]): string[] {
  const out: string[] = []

  for (const run of runs) {
    for (const inner of calls.filter((c) => c.start > run.open && c.start < run.end)) {
      out.push(
        `${rel(file)}:${lineAt(src, inner.start)} — step.${inner.tool}() nested inside `
        + `step.run() opened at line ${lineAt(src, run.start)}`,
      )
    }
  }
  return out
}

/**
 * (2) INDIRECT: a step-using helper called from inside a step.run body.
 *
 * The shape a lexical scan misses, and the one ownerrez-reviews-sync.ts used.
 */
function helperNesting(file: string, src: string, code: string, runs: StepCall[]): string[] {
  const helpers = stepUsingHelpers(code)
  const out: string[] = []

  for (const run of runs) {
    const body = code.slice(run.open, run.end)
    for (const name of helpers) {
      const m = new RegExp(String.raw`\b${name}\s*\(`).exec(body)
      if (!m) continue
      out.push(
        `${rel(file)}:${lineAt(src, run.open + m.index)} — ${name}() uses step.* tooling and is `
        + `called inside step.run() opened at line ${lineAt(src, run.start)}`,
      )
    }
  }
  return out
}

function findViolations(): string[] {
  const out: string[] = []

  for (const file of collectSourceFiles(['lib/inngest'], ['.ts'])) {
    // Blanking preserves offsets, so an index into `code` names the same
    // character — and therefore the same line — in `src`.
    const src   = read(file)
    const code  = readBlanked(file)
    const calls = stepCalls(code)
    const runs  = calls.filter((c) => c.tool === 'run')

    out.push(...directNesting(file, src, calls, runs), ...helperNesting(file, src, code, runs))
  }
  return out.sort()
}

describe('guardrail: Inngest step tooling is never nested', () => {
  it('no step.* call sits inside another step\'s callback, directly or via a helper', () => {
    expect(
      findViolations(),
      'Inngest does not support nested step tooling — the SDK only WARNS, so this ' +
      'does not fail loudly in dev. The enclosing step.run never resolves on that ' +
      'pass and its callback re-runs from the top on the next one, replaying every ' +
      'side effect written before the nested call. Restructure so the step.run ' +
      'returns a DECISION and the step tooling happens at the function\'s top ' +
      'level — see lib/integrations/connection-error-notify.ts.',
    ).toEqual([])
  })

  it('shared lib/ modules carry no step tooling of their own', () => {
    // A helper that takes `step` moves this defect somewhere a reviewer of the
    // Inngest function will never look. connection-error-notify.ts is the
    // deliberate counter-example: plain async DB calls, safe inside a step.run,
    // with the send left to the caller.
    const offenders = collectSourceFiles(['lib'], ['.ts'])
      .filter((f) => !rel(f).startsWith('lib/inngest/'))
      .filter((f) => new RegExp(String.raw`\bstep\.(${STEP_TOOLS})\s*\(`).test(readBlanked(f)))
      .map(rel)
      .sort()

    expect(
      offenders,
      'A shared module must not call Inngest step tooling. Take the data it needs ' +
      'as arguments and let the Inngest function own its own steps.',
    ).toEqual([])
  })
})

// Sanity: the scan must actually FIRE. A checker that is broken and a codebase
// that is clean produce the identical empty array, and this whole file exists
// because a real defect sat in two files for months without anything failing.
describe('guardrail self-check: the nesting scan detects both shapes', () => {
  const FIXTURE_DIRECT = `
    export const f = inngest.createFunction({ id: 'x' }, { event: 'y' }, async ({ step }) => {
      await step.run('outer', async () => {
        await step.sendEvent('inner', { name: 'z', data: {} })
      })
    })
  `
  const FIXTURE_INDIRECT = `
    export const f = inngest.createFunction({ id: 'x' }, { event: 'y' }, async ({ step }) => {
      async function helper() {
        await step.sendEvent('inner', { name: 'z', data: {} })
      }
      await step.run('outer', async () => {
        await helper()
      })
    })
  `
  const FIXTURE_CLEAN = `
    export const f = inngest.createFunction({ id: 'x' }, { event: 'y' }, async ({ step }) => {
      // A comment mentioning step.run() inside prose must not count.
      const due = await step.run('outer', async () => true)
      if (due) await step.sendEvent('inner', { name: 'z', data: {} })
    })
  `

  const directHit = (src: string) => {
    const code  = blankNonCode(src)
    const calls = stepCalls(code)
    return calls.filter((c) => c.tool === 'run')
      .some((run) => calls.some((i) => i.start > run.open && i.start < run.end))
  }

  const indirectHit = (src: string) => {
    const code    = blankNonCode(src)
    const helpers = stepUsingHelpers(code)
    return stepCalls(code).filter((c) => c.tool === 'run')
      .some((run) => helpers.some((n) => new RegExp(String.raw`\b${n}\s*\(`).test(code.slice(run.open, run.end))))
  }

  it('catches a directly nested step call', () => {
    expect(directHit(FIXTURE_DIRECT)).toBe(true)
  })

  it('catches nesting hidden behind a helper — the shape a lexical scan misses', () => {
    expect(directHit(FIXTURE_INDIRECT)).toBe(false)   // invisible to shape (1)
    expect(indirectHit(FIXTURE_INDIRECT)).toBe(true)  // caught by shape (2)
  })

  it('does not flag the correct top-level form, or prose about it', () => {
    expect(directHit(FIXTURE_CLEAN)).toBe(false)
    expect(indirectHit(FIXTURE_CLEAN)).toBe(false)
  })
})
