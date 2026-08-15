#!/usr/bin/env node
// scripts/check-complexity-ratchet.mjs
// ============================================================================
// Per-file ratchet for sonarjs/cognitive-complexity.
//
// WHY THIS EXISTS ON TOP OF `--max-warnings`
//
// `eslint . --max-warnings 165` already stops the TOTAL warning count growing.
// But that budget is FUNGIBLE: a new function at complexity 40 passes CI as
// long as someone deleted a nested ternary in the same PR. The one number
// cannot tell "we cleared a no-nested-conditional" apart from "we added an
// unreadable function", and cognitive complexity is the rule where that
// distinction matters most — it is the one CLAUDE.md states as a hard
// threshold (<= 15) rather than a style preference.
//
// So this pins the shape of the debt, not just its size:
//
//   - a file with NO baseline entry may not have ANY violation. New code
//     complies with the <= 15 rule, full stop.
//   - a baselined file may not gain violations.
//   - a baselined violation may not get WORSE. A function already at 45 going
//     to 60 is invisible to a count-based check; it is the exact direction
//     this is meant to prevent.
//   - an IMPROVEMENT fails too, with a different message, so the burn-down
//     gets recorded in the baseline diff instead of silently leaving room for
//     a future regression to grow back into. Same stance as
//     unit/guardrails/tailwind-color-ratchet's "cleaned-up files must leave
//     the baseline".
//
// The ESLint rule itself stays at `warn`. Flipping it to `error` would fail
// the build on all 36 pre-existing sites at once; this gates the DELTA, which
// is what actually stops the debt growing while it is being paid down.
//
// Usage:
//   node scripts/check-complexity-ratchet.mjs            # check (CI)
//   node scripts/check-complexity-ratchet.mjs --update   # lock in a burn-down
//
// --update REFUSES to grow the baseline, so it cannot be used to wave a new
// violation through — the same rule as scripts/check-semgrep-ratchet.mjs.
// ============================================================================

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'scripts', 'complexity-baseline.json')
const RULE     = 'sonarjs/cognitive-complexity'

/** "…reduce its Cognitive Complexity from 45 to the 15 allowed." */
const SCORE_RE = /from\s+(\d+)\s+to\s+the\s+(\d+)\s+allowed/

/**
 * Runs ESLint over the same target as `npm run lint` and returns every
 * cognitive-complexity violation, grouped by repo-relative path.
 *
 * ESLint exits non-zero when there are ERRORS (and this repo currently has
 * none), but a non-zero exit still carries valid JSON on stdout — so the
 * throw is handled rather than allowed to look like a crash.
 */
function collect() {
  let stdout
  try {
    stdout = execFileSync(
      'npx',
      ['eslint', '.', '-f', 'json'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    )
  } catch (err) {
    if (!err.stdout) {
      console.error('[complexity-ratchet] eslint failed to produce output:\n', err.message)
      process.exit(2)
    }
    stdout = err.stdout
  }

  let report
  try {
    report = JSON.parse(stdout)
  } catch {
    console.error('[complexity-ratchet] could not parse eslint JSON output')
    process.exit(2)
  }

  const found = {}
  for (const file of report) {
    const rel = file.filePath.startsWith(ROOT)
      ? file.filePath.slice(ROOT.length + 1)
      : file.filePath

    for (const msg of file.messages) {
      if (msg.ruleId !== RULE) continue
      const m = SCORE_RE.exec(msg.message ?? '')
      // A message shape we don't recognise must not silently vanish — that
      // would turn an upstream rule-message change into a disarmed check.
      if (!m) {
        console.error(
          `[complexity-ratchet] unrecognised ${RULE} message at ${rel}:${msg.line}\n` +
          `  ${msg.message}\n` +
          `  The score regex needs updating — refusing to run half-blind.`
        )
        process.exit(2)
      }
      ;(found[rel] ??= []).push(Number(m[1]))
    }
  }

  // Sorted descending so comparison is positional and stable regardless of
  // where in the file each function sits. Deliberately NOT keyed on line
  // number: line-keyed baselines rot on every unrelated insertion above them.
  for (const rel of Object.keys(found)) found[rel].sort((a, b) => b - a)
  return found
}

function readBaseline() {
  if (!existsSync(BASELINE)) return {}
  return JSON.parse(readFileSync(BASELINE, 'utf8'))
}

function writeBaseline(data) {
  const ordered = {}
  for (const k of Object.keys(data).sort()) ordered[k] = data[k]
  writeFileSync(BASELINE, JSON.stringify(ordered, null, 2) + '\n')
}

/**
 * Compares actual against baseline.
 * Returns { regressions, improvements } — both arrays of human-readable lines.
 */
function diff(actual, baseline) {
  const regressions = []
  const improvements = []
  const files = [...new Set([...Object.keys(baseline), ...Object.keys(actual)])].sort()

  for (const file of files) {
    const base = baseline[file] ?? []
    const now  = actual[file]   ?? []

    if (!base.length && now.length) {
      regressions.push(
        `NEW  ${file} — ${now.length} violation(s) at complexity ${now.join(', ')}. ` +
        `New code must be at or under 15; extract named helpers or use guard clauses.`
      )
      continue
    }

    if (now.length > base.length) {
      regressions.push(
        `MORE ${file} — ${base.length} baselined, ${now.length} now (${now.join(', ')}).`
      )
      continue
    }

    if (now.length < base.length) {
      improvements.push(
        `FEWER ${file} — ${base.length} baselined, ${now.length} now.`
      )
      continue
    }

    for (let i = 0; i < now.length; i++) {
      if (now[i] > base[i]) {
        regressions.push(
          `WORSE ${file} — a function baselined at ${base[i]} is now ${now[i]}. ` +
          `An already-complex function may not get more complex.`
        )
      } else if (now[i] < base[i]) {
        improvements.push(`LOWER ${file} — ${base[i]} -> ${now[i]}.`)
      }
    }
  }

  return { regressions, improvements }
}

// ── main ────────────────────────────────────────────────────────────────────

const update  = process.argv.includes('--update')
const actual  = collect()
const baseline = readBaseline()
const { regressions, improvements } = diff(actual, baseline)

if (update) {
  if (regressions.length) {
    console.error(
      '[complexity-ratchet] --update refuses to grow the baseline.\n' +
      'Fix these first — the baseline records debt being paid down, never new debt:\n\n' +
      regressions.map((r) => '  ' + r).join('\n') + '\n'
    )
    process.exit(1)
  }
  writeBaseline(actual)
  const total = Object.values(actual).reduce((n, v) => n + v.length, 0)
  console.log(`[complexity-ratchet] baseline updated — ${total} violation(s) in ${Object.keys(actual).length} file(s).`)
  process.exit(0)
}

if (regressions.length) {
  console.error(
    `\n[complexity-ratchet] cognitive complexity regressed (limit is 15 — see CLAUDE.md):\n\n` +
    regressions.map((r) => '  ' + r).join('\n') +
    `\n\nExtract named helper functions, custom hooks, or named predicates, and use\n` +
    `guard clauses / early returns to flatten nesting. This is not waivable by\n` +
    `deleting a warning elsewhere — the --max-warnings budget is a separate,\n` +
    `fungible check, which is exactly why this one exists.\n`
  )
  process.exit(1)
}

if (improvements.length) {
  console.error(
    `\n[complexity-ratchet] complexity IMPROVED but the baseline is stale:\n\n` +
    improvements.map((r) => '  ' + r).join('\n') +
    `\n\nLock it in so the reclaimed headroom cannot be silently refilled:\n` +
    `  node scripts/check-complexity-ratchet.mjs --update\n`
  )
  process.exit(1)
}

const total = Object.values(actual).reduce((n, v) => n + v.length, 0)
console.log(`[complexity-ratchet] OK — ${total} baselined violation(s), none new or worse.`)
