import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Error-reporting coverage ratchet (audit 2026-07-27).
//
// A catch block that only console.error()s — or only logger.error()s to Axiom —
// is invisible in production: no Sentry alert, no grouping, no site/org_id tag.
// At audit time 145 of 316 catch blocks (45%) logged to console and nothing
// else, and a further 39 logged Inngest background-job failures to Axiom only.
// Those are exactly the failures nobody hears about until a customer reports
// them.
//
// This counts catch blocks that log but never reach Sentry, and caps the
// total. The number only goes DOWN — add reportError() alongside the log, and
// lower the budget here in the same PR.
//
// See lib/observability/report-error.ts for the `site` naming convention:
//   serverAction.<domain>.<fn> | route.<path>.<METHOD>
//   inngest.<function-id>[.<step>] | lib.<module>.<fn>
// ============================================================================

// Measured after the audit sweep. Never raise this.
//
// The remaining 1 is a false positive, not a gap: the scanner reads raw source
// and the only match left is inside the commented-out connectWithApiKey body in
// app/(dashboard)/settings/integrations/actions.ts. It drops to 0 if that dead
// code is ever deleted or revived — lower the budget then.
const LOG_ONLY_CATCH_BUDGET = 1

/** Slice from just past an opening `{` to its matching `}`. */
function matchingBlock(src: string, openIndex: number): string {
  let depth = 1
  let i = openIndex
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return src.slice(openIndex, i)
}

function logOnlyCatches(): string[] {
  const out: string[] = []
  for (const file of collectSourceFiles(['app', 'lib'])) {
    const src = read(file)
    for (const m of src.matchAll(/catch\s*\(\s*[A-Za-z0-9_]+\s*\)\s*\{/g)) {
      const block = matchingBlock(src, m.index + m[0].length)
      const reports =
        block.includes('reportError(') || block.includes('captureException')
      const logs =
        block.includes('console.error') || /logger\.(error|warn)\(/.test(block)
      if (logs && !reports) out.push(rel(file))
    }
  }
  return out
}

describe('guardrail: caught errors reach Sentry', () => {
  it(`no more than ${LOG_ONLY_CATCH_BUDGET} catch blocks log without reporting`, () => {
    const offenders = logOnlyCatches()
    const counts = offenders.reduce<Record<string, number>>((acc, f) => {
      acc[f] = (acc[f] ?? 0) + 1
      return acc
    }, {})

    expect(
      offenders.length,
      [
        `log-only catch blocks: ${offenders.length}, budget: ${LOG_ONLY_CATCH_BUDGET}.`,
        '',
        'Add reportError(err, { site: "..." }) alongside the existing log call.',
        'A catch that deliberately swallows (localStorage unavailable, an',
        'optional cache miss) should say so in a comment and log nothing at',
        'all — this check only flags blocks that DO log but never alert.',
        '',
        ...Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([f, c]) => `  ${String(c).padStart(3)}  ${f}`),
      ].join('\n')
    ).toBeLessThanOrEqual(LOG_ONLY_CATCH_BUDGET)
  })
})
