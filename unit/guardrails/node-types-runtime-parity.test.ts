import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// @types/node DESCRIBES THE RUNTIME. IT MAY NOT LEAD IT OR LAG IT.
//
// Three places name the Node version and all three must agree:
//
//   package.json  engines.node                 — what we claim to support
//   package.json  devDependencies["@types/node"] — what the COMPILER believes
//   .github/workflows/*.yml  node-version:     — what CI actually runs
//
// A types package ahead of the runtime is the dangerous direction, and it is
// silent in the worst way: the compiler describes APIs that do not exist in
// production, so the code type-checks green and throws at runtime. Behind is
// milder but still wrong — real APIs read as errors and get worked around.
//
// WHY THIS EXISTS AS A TEST RATHER THAN A NOTE
//
// Until 2026-08-21, Dependabot WAS the enforcement: it reopened the bump every
// week (PR #364, 22.20.0 -> 26.1.2, four majors ahead of a Node 22 runtime) and
// somebody eventually looked at it. That PR was correctly refused and
// @types/node was added to .github/dependabot.yml's ignore list — which removed
// the nagging AND the only mechanism that would ever have surfaced drift.
//
// So this is the replacement for the signal that suppression cost, and it
// checks the direction Dependabot never could: it also fails when engines.node
// or CI moves and the types are left behind. Raising the runtime is exactly
// when the ignore rule makes the types easiest to forget.
// ============================================================================

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

/** Leading major from any of `22`, `>=22`, `^22.10.0`, `22.x`, `v22`. */
function majorOf(spec: string): number | null {
  const m = /(\d+)/.exec(spec)
  return m ? Number(m[1]) : null
}

const pkg = JSON.parse(read('package.json')) as {
  engines?:         { node?: string }
  devDependencies?: Record<string, string>
  dependencies?:    Record<string, string>
}

const WORKFLOW_DIR = '.github/workflows'

/** Every `node-version:` pinned across CI, as { file, major }. */
function ciNodeVersions(): Array<{ file: string; major: number }> {
  const out: Array<{ file: string; major: number }> = []

  for (const name of readdirSync(join(process.cwd(), WORKFLOW_DIR))) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue
    const src = read(`${WORKFLOW_DIR}/${name}`)

    for (const m of src.matchAll(/node-version:\s*['"]?([\d.x]+)['"]?/g)) {
      const major = majorOf(m[1])
      // A matrix expression (${{ matrix.node }}) yields no digits and is
      // skipped rather than guessed at — better silent on a shape we cannot
      // read than confidently wrong about it.
      if (major !== null) out.push({ file: name, major })
    }
  }

  return out
}

describe('guardrail: @types/node tracks the Node runtime', () => {
  it('engines.node and @types/node name the same major', () => {
    const engines = pkg.engines?.node
    expect(engines, 'package.json has no engines.node — this file assumes it does').toBeTruthy()

    const typesSpec = pkg.devDependencies?.['@types/node'] ?? pkg.dependencies?.['@types/node']
    expect(typesSpec, '@types/node is not a dependency — has it been removed?').toBeTruthy()

    const runtimeMajor = majorOf(engines!)
    const typesMajor   = majorOf(typesSpec!)

    expect(typesMajor, [
      `@types/node is ${typesSpec} but engines.node is ${engines}.`,
      '',
      'AHEAD of the runtime: the compiler describes APIs that do not exist in',
      'production. Code type-checks green and throws when it runs — the worst',
      'available failure mode, because CI agrees with you.',
      '',
      'BEHIND the runtime: real APIs read as type errors and get worked around',
      'or cast away.',
      '',
      'If the RUNTIME moved, move engines.node, every node-version: in',
      '.github/workflows/, and @types/node together in one change. If a bot',
      'moved the types alone, close it — .github/dependabot.yml ignores major',
      'bumps here on purpose, and that is why nothing else would catch this.',
    ].join('\n')).toBe(runtimeMajor)
  })

  it('every CI job runs the major that engines.node claims', () => {
    const runtimeMajor = majorOf(pkg.engines!.node!)
    const found        = ciNodeVersions()

    // Zero would make the assertion below vacuously true — see the self-check,
    // but fail loudly here too, since a renamed key is the likely cause.
    expect(found.length, 'no node-version: found in any workflow').toBeGreaterThan(0)

    const mismatched = found.filter((v) => v.major !== runtimeMajor)

    expect(mismatched, [
      `A CI job pins a Node major that engines.node (${pkg.engines!.node}) does not claim.`,
      '',
      'CI is the only place the runtime is actually exercised. A job on a',
      'different major means the suite that gates merges is not testing what',
      'production runs, and @types/node is then pinned to the wrong one of the',
      'two no matter which it matches.',
    ].join('\n')).toEqual([])
  })

  it('dependabot.yml still ignores major bumps for @types/node', () => {
    // The ignore entry and this test are one mechanism in two halves. Drop the
    // entry and the weekly PR returns — noisy, but caught. Drop THIS and the
    // entry silently permits a bump nobody is watching for. The second is the
    // failure worth guarding.
    const cfg = read('.github/dependabot.yml')

    const entry = /dependency-name:\s*["']?@types\/node["']?[\s\S]{0,200}?version-update:semver-major/
    expect(cfg, [
      '.github/dependabot.yml no longer ignores major @types/node bumps.',
      '',
      'That entry is deliberate: the types are pinned to engines.node, so a',
      'major bump is never right on its own. Removing it reopens PR #364 every',
      'week forever.',
      '',
      'If the ignore was removed because the pinning policy CHANGED, delete',
      'this test file in the same commit and say why — do not leave a test',
      'asserting a policy that no longer holds.',
    ].join('\n')).toMatch(entry)
  })

  it('SELF-CHECK: the parser and the workflow scan actually find things', () => {
    // Every assertion above is an equality against a parsed number. If majorOf
    // silently returned null for both sides, or the workflow scan found
    // nothing, the checks pass while measuring nothing at all.
    expect(majorOf('>=22')).toBe(22)
    expect(majorOf('^22.10.0')).toBe(22)
    expect(majorOf('26.1.2')).toBe(26)
    expect(majorOf('v24')).toBe(24)
    expect(majorOf('${{ matrix.node }}')).toBeNull()

    // The mismatch it is meant to catch really is a mismatch.
    expect(majorOf('^26.1.2')).not.toBe(majorOf('>=22'))

    expect(ciNodeVersions().length).toBeGreaterThan(0)
  })
})
