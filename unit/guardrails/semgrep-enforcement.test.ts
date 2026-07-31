import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ROOT } from './scan'

// ============================================================================
// Semgrep enforcement guardrail — the semgrep layer's own enforcement.
//
// The semgrep job is only a gate for as long as its wiring stays intact, and
// two parts of that wiring fail SILENTLY rather than loudly:
//
//   1. `--baseline-commit <base>` needs the base commit's objects in the local
//      clone. actions/checkout defaults to fetch-depth: 1 — which does NOT
//      contain the base commit. Drop `fetch-depth: 0` and semgrep can no longer
//      resolve the baseline; the diff gate degrades with nothing going red.
//
//   2. Every rule in ratchet.yml needs an entry in baseline-counts.json.
//      A rule with no committed count is unmeasured: check-semgrep-ratchet.mjs
//      has nothing to compare it against, so the class can grow freely.
//      Checked here in BOTH directions, same discipline as env-schema-coverage.
//
// The chokepoint family's "must stay at zero" property is NOT asserted here —
// that requires running semgrep, which is the CI job's business. This test only
// guards the wiring around it.
// ============================================================================

const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
const ciDirectives = ci
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n')

const ratchetYml = readFileSync(join(ROOT, '.semgrep', 'ratchet.yml'), 'utf8')
const chokepointsYml = readFileSync(join(ROOT, '.semgrep', 'chokepoints.yml'), 'utf8')
const baseline = JSON.parse(readFileSync(join(ROOT, '.semgrep', 'baseline-counts.json'), 'utf8')) as {
  counts: Record<string, number>
}

const ruleIds = (yml: string) => [...yml.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1]!)

describe('guardrail: semgrep CI wiring', () => {
  it('CI has a semgrep job that runs both rule families', () => {
    expect(ciDirectives).toMatch(/^\s{2}semgrep:$/m)
    expect(ciDirectives).toContain('.semgrep/chokepoints.yml')
    expect(ciDirectives).toContain('.semgrep/ratchet.yml')
    expect(ciDirectives).toContain('node scripts/check-semgrep-ratchet.mjs')
  })

  it('the semgrep version is pinned', () => {
    expect(
      /pip install semgrep==\d+\.\d+\.\d+/.test(ciDirectives),
      'An unpinned semgrep turns a rule-engine release into an unexplained CI failure on an unrelated PR.',
    ).toBe(true)
  })

  it('the chokepoint family gates at --error on the whole tree', () => {
    const line = ciDirectives
      .split('\n')
      .find((l) => l.includes('.semgrep/chokepoints.yml'))
    expect(line, 'ci.yml no longer runs the chokepoint rules').toBeDefined()
    expect(line).toContain('--error')
    expect(
      line,
      'the chokepoint family must scan the whole tree, not --baseline-commit the diff — it is already at zero',
    ).not.toContain('--baseline-commit')
  })

  it('the ratchet family gates on --baseline-commit', () => {
    expect(ciDirectives).toContain('--baseline-commit')
  })

  it('the semgrep job checks out full history (--baseline-commit needs the base commit)', () => {
    const job = ci.slice(ci.indexOf('\n  semgrep:'), ci.indexOf('\n  e2e:'))
    expect(
      /fetch-depth:\s*0/.test(job),
      "actions/checkout defaults to fetch-depth: 1, which does not contain the PR base commit. Without fetch-depth: 0, --baseline-commit cannot resolve its baseline and the diff gate degrades silently.",
    ).toBe(true)
  })
})

describe('guardrail: semgrep ratchet baseline stays complete', () => {
  it('every ratchet rule has a committed count, and every count has a rule', () => {
    expect(ruleIds(ratchetYml).sort()).toEqual(Object.keys(baseline.counts).sort())
  })

  it('no rule id is declared in both families', () => {
    const overlap = ruleIds(ratchetYml).filter((id) => ruleIds(chokepointsYml).includes(id))
    expect(overlap, 'a rule cannot be both a chokepoint (gates at 0) and a ratchet (frozen above 0)').toEqual([])
  })

  it('the ratchet script needs no dependency install', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'check-semgrep-ratchet.mjs'), 'utf8')
    const external = [...src.matchAll(/^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm)]
      .map((m) => m[1]!)
      .filter((s) => !s.startsWith('node:') && !s.startsWith('.'))
    expect(
      external,
      'the semgrep CI job has no pnpm install step. Either drop the dependency or add one.',
    ).toEqual([])
  })
})
