#!/usr/bin/env node
/**
 * FieldStay — semgrep ratchet check (structural enforcement, semgrep layer).
 *
 * The chokepoint rules (.semgrep/chokepoints.yml) sit at zero findings and gate
 * at --error across the whole tree. The RATCHET rules (.semgrep/ratchet.yml)
 * cannot: each covers a defect class with hundreds of pre-existing sites. CI
 * gates those on `--baseline-commit` so only NEW findings fail a PR — but a
 * diff-scoped gate says nothing about whether the backlog is shrinking, and
 * "we're burning it down" with no committed number is an assertion, not a fact.
 *
 * This script is the number. It re-runs the ratchet rules, compares each rule's
 * finding count against .semgrep/baseline-counts.json, and fails when a count
 * went UP. A burn-down PR lowers the file (via --update) and the diff shows
 * exactly how much ground was taken.
 *
 *   node scripts/check-semgrep-ratchet.mjs            # verify (CI)
 *   node scripts/check-semgrep-ratchet.mjs --update   # lock in progress
 *
 * Rule ids and baseline keys must correspond exactly in BOTH directions — a
 * rule with no baseline entry is unmeasured, and a baseline entry for a rule
 * that no longer exists is a number nobody can lower. Same drift discipline as
 * lib/env.ts's ENV_SPEC.
 *
 * Node builtins + the `semgrep` binary only — no pnpm install in the CI job.
 * Self-disarms (warn + exit 0) when semgrep is not on PATH, mirroring the
 * db-invariants scripts, so a fork PR or a local run without semgrep installed
 * is loud-but-green rather than permanently red.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RULES = join(ROOT, '.semgrep', 'ratchet.yml')
const BASELINE_FILE = join(ROOT, '.semgrep', 'baseline-counts.json')
const UPDATE = process.argv.includes('--update')

// ── Is semgrep available? ───────────────────────────────────────────────────
const probe = spawnSync('semgrep', ['--version'], { encoding: 'utf8' })
if (probe.error || probe.status !== 0) {
  console.log(
    '::warning title=Semgrep ratchet UNARMED::The `semgrep` binary is not on ' +
      'PATH, so the per-rule ratchet counts in .semgrep/baseline-counts.json ' +
      'were NOT verified. Install semgrep (pip install semgrep==1.172.0) to arm ' +
      'this check locally; the CI semgrep job installs it explicitly.'
  )
  process.exit(0)
}

// ── Run the ratchet rules ───────────────────────────────────────────────────
const run = spawnSync('semgrep', ['--config', RULES, '--json', '--quiet', '--metrics', 'off'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})

if (run.status !== 0 && !run.stdout) {
  console.error('semgrep failed to run:\n' + (run.stderr ?? '(no stderr)'))
  process.exit(1)
}

/** @type {{ results: Array<{ check_id: string }> }} */
const report = JSON.parse(run.stdout)

/** semgrep prefixes check_id with the config path when run from a file. */
const ruleIdOf = (checkId) => checkId.split('.').pop()

const actual = {}
for (const result of report.results) {
  const id = ruleIdOf(result.check_id)
  actual[id] = (actual[id] ?? 0) + 1
}

// Every rule declared in ratchet.yml must appear, including at zero — a rule
// that stops matching anything should show 0, not vanish from the report.
const declared = [...readFileSync(RULES, 'utf8').matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1])
for (const id of declared) actual[id] ??= 0

// ── Compare ─────────────────────────────────────────────────────────────────
const baselineDoc = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
const baseline = baselineDoc.counts

if (UPDATE) {
  baselineDoc.counts = Object.fromEntries(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b)))
  baselineDoc.measured_at = new Date().toISOString().slice(0, 10)
  writeFileSync(BASELINE_FILE, JSON.stringify(baselineDoc, null, 2) + '\n')
  console.log('Updated .semgrep/baseline-counts.json:')
  for (const [id, n] of Object.entries(baselineDoc.counts)) {
    const was = baseline[id]
    console.log(`  ${id}: ${was === undefined ? 'new ' : `${was} -> `}${n}`)
  }
  process.exit(0)
}

const failures = []
const improvements = []

for (const id of new Set([...Object.keys(actual), ...Object.keys(baseline)])) {
  const now = actual[id]
  const was = baseline[id]

  if (was === undefined) {
    failures.push(
      `${id}: rule has no entry in .semgrep/baseline-counts.json (found ${now}). ` +
        'A rule with no committed count is unmeasured — run with --update.'
    )
    continue
  }
  if (now === undefined) {
    failures.push(
      `${id}: baseline entry exists but .semgrep/ratchet.yml declares no such rule. ` +
        'Remove the stale entry (--update) — a number nobody can lower is not a ratchet.'
    )
    continue
  }
  if (now > was) {
    failures.push(`${id}: ${was} -> ${now}  (+${now - was}) — this class GREW.`)
  } else if (now < was) {
    improvements.push(`${id}: ${was} -> ${now}  (-${was - now})`)
  }
}

console.log('semgrep ratchet — per-rule counts')
for (const id of Object.keys(actual).sort()) {
  console.log(`  ${String(actual[id]).padStart(5)}  ${id}   (baseline ${baseline[id] ?? '—'})`)
}

if (improvements.length) {
  console.log(
    '::warning title=Semgrep ratchet has slack::' +
      `${improvements.length} rule(s) now find FEWER sites than the committed baseline ` +
      '(' + improvements.join('; ') + '). Run `node scripts/check-semgrep-ratchet.mjs --update` ' +
      'and commit the file so the progress is locked in and cannot silently regress.'
  )
}

if (failures.length) {
  console.error('\n::error title=Semgrep ratchet regression::A frozen defect class grew.')
  for (const f of failures) console.error('  ✗ ' + f)
  console.error(
    '\nFix the new sites. Do NOT raise a number in .semgrep/baseline-counts.json and do ' +
      'NOT add a nosemgrep comment — a suppressed rule reports zero and means nothing.'
  )
  process.exit(1)
}

console.log('\nOK — no ratchet count increased.')
