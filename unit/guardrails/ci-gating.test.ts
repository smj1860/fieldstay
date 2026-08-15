import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ROOT } from './scan'

// ============================================================================
// CI gating guardrail — the enforcement layer's own enforcement.
//
// Every other guardrail in this directory assumes CI actually runs it. Nothing
// checked that assumption, and the 2026-07-30 pre-launch audit found two ways
// it had already drifted:
//
//   1. `pnpm run lint` was plain `eslint .`. The sonarjs rules are `warn`
//      pending a cleanup pass, so eslint exits 0 no matter how many warnings
//      exist — the complexity total drifted 236 → 240 with CI green the whole
//      time. The fix is `--max-warnings <current>`, a ratchet that can only be
//      lowered. Dropping the flag would restore the blind spot invisibly,
//      because nothing would go red.
//
//   2. The `db-invariants` job has no `pnpm install` step — it runs
//      `node scripts/check-*.mjs` straight after setup-node. That is FINE, and
//      deliberately so: both scripts use only Node builtins and global fetch,
//      so skipping an install keeps the job fast. But it is fine only for
//      exactly as long as that stays true. The day someone adds
//      `import { createClient } from '@supabase/supabase-js'` to one of them,
//      the job fails at runtime in CI and nowhere else. The last check below
//      is what makes that a local test failure instead.
//
// These are cheap string assertions on ci.yml and package.json rather than a
// YAML parse — the point is to notice a step disappearing, not to model
// GitHub Actions.
// ============================================================================

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

/**
 * ci.yml is heavily commented, and those comments discuss the very strings
 * checked below ("No continue-on-error", the step names). Assertions about
 * what CI actually DOES have to read the directives only.
 */
const ciDirectives = ci
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n')

/** Scripts run by `node` in CI with no dependency install ahead of them. */
const INSTALL_FREE_SCRIPTS = [
  'scripts/check-db-invariants.mjs',
  'scripts/check-type-drift.mjs',
  'scripts/check-migration-ledger.mjs',
]

describe('guardrail: lint warning ratchet', () => {
  it('the lint script carries --max-warnings so warning drift fails CI', () => {
    const lint = pkg.scripts.lint ?? ''
    expect(
      /--max-warnings\s+\d+/.test(lint),
      'pnpm run lint must pass --max-warnings <current total>. Without it eslint exits 0 on any number of warnings and the sonarjs complexity budget is unenforceable.',
    ).toBe(true)
  })

  it('the --max-warnings budget is a ratchet that only moves down', () => {
    // Measured 2026-07-30 after the pre-launch remediation pass (240 before it);
    // lowered to 202 on 2026-07-31 when the four SonarCloud cognitive-complexity
    // violations (crew inventory-count route, work-order-ops cron, vendor-connect
    // onboard route, notifications bell) were refactored out.
    // LOWER this when warnings are cleared; never raise it.
    const CEILING = 202
    const budget = Number(/--max-warnings\s+(\d+)/.exec(pkg.scripts.lint ?? '')?.[1])
    expect(budget).toBeLessThanOrEqual(CEILING)
  })
})

describe('guardrail: the cognitive-complexity ratchet stays armed', () => {
  // --max-warnings is a TOTAL, and totals are fungible: a new function at
  // complexity 40 passes it as long as the same PR cleared a nested ternary
  // somewhere else. That is not a hypothetical trade — no-nested-conditional
  // alone is 92 of the 165 warnings, so there is ample currency to pay for a
  // complexity regression with. scripts/check-complexity-ratchet.mjs gates the
  // per-FILE delta instead; these assertions are what stop it being unwired.
  const baseline = JSON.parse(
    readFileSync(join(ROOT, 'scripts', 'complexity-baseline.json'), 'utf8'),
  ) as Record<string, number[]>

  it('the check:complexity script exists and points at the ratchet', () => {
    expect(pkg.scripts['check:complexity'] ?? '').toContain('check-complexity-ratchet.mjs')
  })

  it('the baseline is a ratchet that only moves down', () => {
    // Seeded 2026-08-15: 36 violations across 31 files, worst at 45
    // (app/crew/turnovers/[id]/ChecklistView.tsx).
    // LOWER these when violations are cleared; never raise them.
    const FILE_CEILING  = 31
    const TOTAL_CEILING = 36

    const total = Object.values(baseline).reduce((n, scores) => n + scores.length, 0)
    expect(Object.keys(baseline).length).toBeLessThanOrEqual(FILE_CEILING)
    expect(total).toBeLessThanOrEqual(TOTAL_CEILING)
  })

  it('no baselined score is at or under the limit — those entries are dead weight', () => {
    // A baselined 15 or lower means the rule no longer fires there, so the
    // entry grants silent headroom back up to its recorded value.
    const stale = Object.entries(baseline)
      .flatMap(([file, scores]) => scores.filter((s) => s <= 15).map((s) => `${file}:${s}`))
    expect(stale, 'run `node scripts/check-complexity-ratchet.mjs --update`').toEqual([])
  })
})

describe('guardrail: CI runs every gate', () => {
  it('the checks job runs the full verification pass', () => {
    for (const step of [
      'pnpm run check:ui-classes',
      'pnpm exec tsc --noEmit',
      'pnpm run lint',
      'pnpm run check:complexity',
      'pnpm test',
      'pnpm run build',
    ]) {
      expect(ciDirectives, `ci.yml lost the "${step}" step`).toContain(step)
    }
  })

  it('no CI step is marked continue-on-error (a green X is not a gate)', () => {
    expect(ciDirectives).not.toMatch(/continue-on-error/)
  })

  // A run that verifies a MERGE COMMIT must not be cancellable. The concurrency
  // block is a single repo-wide group so that runs cannot race each other over
  // the shared E2E Supabase project — correct, and load-bearing — but with a
  // flat `cancel-in-progress: true` the push run for a merge is as disposable
  // as any other. On 2026-08-06 PR #576 merged at 15:09:30, the push run for
  // merge commit 3a16a06c started at 15:09:36, and the next event to arrive
  // cancelled it 46 seconds later. main's HEAD was never verified by anything.
  //
  // A PR run is genuinely superseded by the next push to that PR. A push to
  // main is superseded by nothing — it is the only run that will ever evaluate
  // that commit.
  it('a push to main is never cancelled by a later run', () => {
    const block = /concurrency:\s*\n(?:\s+#[^\n]*\n)*\s+group:[^\n]*\n\s+cancel-in-progress:\s*([^\n]+)/.exec(ci)

    expect(block, 'ci.yml no longer has a concurrency block with cancel-in-progress').not.toBeNull()

    const value = block![1]!.trim()
    expect(
      value,
      'cancel-in-progress must exclude push events, or a merge commit\'s ' +
      'verification run can be cancelled and main ships unverified. Expected an ' +
      "expression gated on github.event_name != 'push'.",
    ).toMatch(/github\.event_name\s*!=\s*'push'/)
  })

  // Without a manual trigger the only way to ask "is CI working?" is to push a
  // commit, which is a poor diagnostic instrument — and was the actual
  // constraint while investigating the run-creation stop on 2026-08-06.
  it('CI can be triggered manually', () => {
    expect(ci).toMatch(/^\s*workflow_dispatch:/m)
  })

  it('the db-invariants job runs every live-schema check', () => {
    for (const script of INSTALL_FREE_SCRIPTS) {
      expect(ciDirectives, `ci.yml no longer runs ${script}`).toContain(`node ${script}`)
    }
  })
})

describe('guardrail: install-free CI scripts stay install-free', () => {
  it.each(INSTALL_FREE_SCRIPTS)('%s imports only Node builtins', (script) => {
    const src = readFileSync(join(ROOT, script), 'utf8')
    const specifiers = [...src.matchAll(/^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]!)
    const external = specifiers.filter((s) => !s.startsWith('node:') && !s.startsWith('.'))

    expect(
      external,
      `${script} runs in the db-invariants CI job, which has NO pnpm install step. Either drop the dependency or add an install step to that job.`,
    ).toEqual([])
  })

  it.each(INSTALL_FREE_SCRIPTS)('%s self-disarms when the E2E secrets are absent', (script) => {
    const src = readFileSync(join(ROOT, script), 'utf8')
    // Fork PRs and unconfigured repos have no secrets. The job must warn and
    // pass, mirroring the e2e job's gate — a permanently red required check is
    // one nobody looks at.
    expect(src).toMatch(/::warning title=.*UNARMED/)
    expect(src).toMatch(/process\.exit\(0\)/)
  })

  // The other half of that trade-off. Self-disarming is right for forks and
  // wrong for the canonical repo, where an absent secret is a misconfiguration
  // and the warn-and-pass path renders as a green required check for work
  // nobody did. On 2026-08-03 the db-invariants job WAS armed and did run —
  // but the check status alone could not have told you that either way, and
  // that indistinguishability is the defect, not the outcome.
  // DB_INVARIANTS_REQUIRE_ARMED is what separates the two cases; without it
  // the disarm is unconditional again.
  it.each(INSTALL_FREE_SCRIPTS)('%s fails loudly when armedness is REQUIRED but secrets are absent', (script) => {
    const src = readFileSync(join(ROOT, script), 'utf8')
    expect(
      src,
      `${script} must honour DB_INVARIANTS_REQUIRE_ARMED — otherwise an unarmed run on the canonical repo passes silently.`,
    ).toMatch(/DB_INVARIANTS_REQUIRE_ARMED/)
    // The require-armed branch has to EXIT NON-ZERO; matching the env var name
    // alone would pass on a version that merely logged and carried on — and
    // would also match the header comment rather than any code, which is
    // exactly what a first-draft version of this assertion did.
    expect(
      src,
      `${script}'s DB_INVARIANTS_REQUIRE_ARMED branch must exit non-zero, not just log.`,
    ).toMatch(/process\.env\.DB_INVARIANTS_REQUIRE_ARMED[\s\S]{0,800}?process\.exit\(1\)/)
  })

  it('the db-invariants CI job sets DB_INVARIANTS_REQUIRE_ARMED', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
    expect(
      ci,
      'The db-invariants job must set DB_INVARIANTS_REQUIRE_ARMED, or the scripts fall back to warn-and-pass and the gate can go green without running.',
    ).toMatch(/DB_INVARIANTS_REQUIRE_ARMED:/)
  })

  // The production refusal is a default, not a prohibition: the report
  // function is read-only, so a human must be able to point this at prod
  // deliberately. That escape hatch is the only way the gate's assurances ever
  // describe production rather than the E2E project.
  it('check-db-invariants.mjs allows a deliberate, opt-in production run', () => {
    const src = readFileSync(join(ROOT, 'scripts/check-db-invariants.mjs'), 'utf8')
    expect(src).toMatch(/DB_INVARIANTS_ALLOW_PROD/)
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['check:db-invariants:prod']).toBeDefined()
  })

  // Same escape hatch, and for a stronger reason: the ledger-parity invariant
  // is ABOUT production. The repo is the source of truth for what production
  // has applied, and CI can only ever observe the E2E project.
  it('check-migration-ledger.mjs allows a deliberate, opt-in production run', () => {
    const src = readFileSync(join(ROOT, 'scripts/check-migration-ledger.mjs'), 'utf8')
    expect(src).toMatch(/DB_INVARIANTS_ALLOW_PROD/)
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['check:migration-ledger:prod']).toBeDefined()
  })
})

// ============================================================================
// The ledger-parity baseline is a RATCHET, and a ratchet whose baseline can be
// edited freely is a suppression list. scripts/check-migration-ledger.mjs
// enforces "shrink-only" against the LIVE ledger, which CI can only do for the
// one project it holds secrets for — these assertions hold for the file itself,
// with no database, so they also run on a fork and in every local `pnpm test`.
//
// Production's entry being EMPTY is the load-bearing one. It was reconciled on
// 2026-08-03 (audit H10) from 36 local-only / 35 ledger-only to exact 1:1
// parity, which is what makes prod a hard gate rather than a grandfathered
// mess. Re-populating it would silently restore the pre-H10 world.
// ============================================================================
describe('guardrail: migration ledger baseline is shrink-only', () => {
  const PROD_REF = 'vpmznjktllhmmbfnxuvk'
  const baseline = JSON.parse(
    readFileSync(join(ROOT, 'scripts/migration-ledger-baseline.json'), 'utf8'),
  ) as {
    projects: Record<string, { label?: string; localOnly: string[]; ledgerOnly: string[] }>
  }

  it('production carries NO grandfathered divergence', () => {
    const prod = baseline.projects[PROD_REF]
    expect(prod, 'the production entry must stay in the baseline, empty').toBeDefined()
    expect(
      [...prod!.localOnly, ...prod!.ledgerOnly],
      'Production was reconciled to exact 1:1 parity on 2026-08-03. An entry here means new drift was grandfathered instead of fixed — record the migration, or commit the missing file.',
    ).toEqual([])
  })

  // Ceilings, not targets. LOWER them as the E2E project is repaired; never
  // raise them. A raise is the "absorb the new drift" move the script's
  // --update mode already refuses at runtime.
  it.each([
    ['syhthijeqlnltufdawyb', 70, 133],
  ])('%s stays within its frozen divergence ceiling', (ref, maxLocalOnly, maxLedgerOnly) => {
    const entry = baseline.projects[ref]
    expect(entry, `baseline entry for ${ref} disappeared`).toBeDefined()
    expect(entry!.localOnly.length).toBeLessThanOrEqual(maxLocalOnly)
    expect(entry!.ledgerOnly.length).toBeLessThanOrEqual(maxLedgerOnly)
  })

  it('every grandfathered version is a well-formed migration version', () => {
    const malformed: string[] = []
    for (const [ref, entry] of Object.entries(baseline.projects)) {
      for (const v of [...entry.localOnly, ...entry.ledgerOnly]) {
        if (!/^\d{14}$/.test(v)) malformed.push(`${ref}: ${v}`)
      }
    }
    expect(malformed, 'baseline entries are bare YYYYMMDDHHMMSS versions, not filenames').toEqual([])
  })

  it('no version is listed as BOTH local-only and ledger-only', () => {
    // Mutually exclusive by construction — a version present in both sets
    // would mean the diff that produced it was computed wrong, and the entry
    // would then mask a real finding on whichever side later diverges.
    const overlaps: string[] = []
    for (const [ref, entry] of Object.entries(baseline.projects)) {
      const local = new Set(entry.localOnly)
      for (const v of entry.ledgerOnly) if (local.has(v)) overlaps.push(`${ref}: ${v}`)
    }
    expect(overlaps).toEqual([])
  })
})
