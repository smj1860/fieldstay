#!/usr/bin/env node
// scripts/check-complexity-ratchet.mjs
// ============================================================================
// Per-file ratchet for sonarjs/cognitive-complexity.
//
// WHY THIS EXISTS ON TOP OF `--max-warnings`
//
// `eslint . --max-warnings 165` already stops the TOTAL warning count growing.
// But that budget is FUNGIBLE: a new function at complexity 40 passes CI as
// long as the same PR deleted a nested ternary somewhere else. One number
// cannot tell "we cleared a no-nested-conditional" apart from "we added an
// unreadable function", and cognitive complexity is the rule where that
// distinction matters most — CLAUDE.md states it as a hard threshold (<= 15),
// not a style preference.
//
// So this pins the SHAPE of the debt, not just its size:
//
//   - a file with no baseline entry may not have ANY violation. New code
//     complies with <= 15, full stop.
//   - a baselined file may not gain violations.
//   - a baselined violation may not get WORSE. A function already at 45 going
//     to 60 is invisible to a count-based check, and is the exact direction
//     this is meant to prevent.
//   - an IMPROVEMENT also fails, with a different message, so the burn-down is
//     recorded in the baseline diff instead of silently leaving headroom a
//     later regression can grow back into. Same stance as
//     unit/guardrails/tailwind-color-ratchet's "cleaned-up files must leave
//     the baseline".
//
// The ESLint rule itself stays at `warn`. Flipping it to `error` would fail
// the build on all pre-existing sites at once; this gates the DELTA, which is
// what stops the debt growing while it is paid down.
//
// Usage:
//   node scripts/check-complexity-ratchet.mjs           # check (CI)
//   node scripts/check-complexity-ratchet.mjs --init    # seed (baseline absent)
//   node scripts/check-complexity-ratchet.mjs --update  # lock in a burn-down
//
// --update REFUSES to grow the baseline, so it cannot wave a new violation
// through — same rule as scripts/check-semgrep-ratchet.mjs. --init exists
// because without it the first run is unbootstrappable: with no baseline every
// file reads as NEW, so --update would refuse to write the very file it is
// meant to seed.
//
// Uses ESLint's Node API rather than spawning `npx eslint`. That is not a
// style choice: resolving a bare `npx` through PATH is the CWE Sonar flags as
// javascript:S4036, and the API also skips a second full process start.
// ============================================================================

import { ESLint } from 'eslint'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'scripts', 'complexity-baseline.json')
const RULE     = 'sonarjs/cognitive-complexity'

/** "…reduce its Cognitive Complexity from 45 to the 15 allowed." */
const SCORE_RE = /from\s+(\d+)\s+to\s+the\s+(\d+)\s+allowed/

/** Sorts strings deterministically. A bare .sort() is locale/impl-dependent. */
const byName = (a, b) => a.localeCompare(b)

/** Sorts scores high-to-low, so file comparison is positional and stable. */
const byScoreDesc = (a, b) => b - a

// ── collection ──────────────────────────────────────────────────────────────

/**
 * Extracts the reported complexity from a rule message.
 *
 * Returns null when the shape is unrecognised — the caller treats that as
 * fatal rather than skipping it, so an upstream message change cannot silently
 * disarm the whole check.
 */
function scoreOf(message) {
  const m = SCORE_RE.exec(message ?? '')
  return m ? Number(m[1]) : null
}

/** Adds one violation to the grouped map. */
function record(found, file, score) {
  if (!found[file]) found[file] = []
  found[file].push(score)
}

/** Every cognitive-complexity violation in one ESLint result, grouped by file. */
function violationsIn(result, found) {
  const file = relative(ROOT, result.filePath)

  for (const msg of result.messages) {
    if (msg.ruleId !== RULE) continue

    const score = scoreOf(msg.message)
    if (score === null) {
      console.error(
        `[complexity-ratchet] unrecognised ${RULE} message at ${file}:${msg.line}\n` +
        `  ${msg.message}\n` +
        `  The score regex needs updating — refusing to run half-blind.`
      )
      process.exit(2)
    }

    record(found, file, score)
  }
}

/** Lints the same target as `npm run lint` and returns violations by file. */
async function collect() {
  const eslint  = new ESLint({ cwd: ROOT })
  const results = await eslint.lintFiles(['.'])

  const found = {}
  for (const result of results) violationsIn(result, found)
  for (const file of Object.keys(found)) found[file].sort(byScoreDesc)
  return found
}

// ── baseline I/O ────────────────────────────────────────────────────────────

function readBaseline() {
  if (!existsSync(BASELINE)) return {}
  return JSON.parse(readFileSync(BASELINE, 'utf8'))
}

function writeBaseline(data) {
  const ordered = {}
  for (const key of Object.keys(data).sort(byName)) ordered[key] = data[key]
  writeFileSync(BASELINE, JSON.stringify(ordered, null, 2) + '\n')
}

function totalOf(data) {
  return Object.values(data).reduce((n, scores) => n + scores.length, 0)
}

// ── comparison ──────────────────────────────────────────────────────────────

/** Compares one file's baselined scores against its current ones. */
function compareFile(file, base, now, out) {
  if (base.length === 0) {
    out.regressions.push(
      `NEW   ${file} — ${now.length} violation(s) at complexity ${now.join(', ')}. ` +
      `New code must be at or under 15: extract named helpers or use guard clauses.`
    )
    return
  }

  if (now.length > base.length) {
    out.regressions.push(
      `MORE  ${file} — ${base.length} baselined, ${now.length} now (${now.join(', ')}).`
    )
    return
  }

  if (now.length < base.length) {
    out.improvements.push(`FEWER ${file} — ${base.length} baselined, ${now.length} now.`)
    return
  }

  for (let i = 0; i < now.length; i++) {
    if (now[i] > base[i]) {
      out.regressions.push(
        `WORSE ${file} — a function baselined at ${base[i]} is now ${now[i]}. ` +
        `An already-complex function may not get more complex.`
      )
    } else if (now[i] < base[i]) {
      out.improvements.push(`LOWER ${file} — ${base[i]} -> ${now[i]}.`)
    }
  }
}

function diff(actual, baseline) {
  const out   = { regressions: [], improvements: [] }
  const files = [...new Set([...Object.keys(baseline), ...Object.keys(actual)])].sort(byName)

  for (const file of files) {
    compareFile(file, baseline[file] ?? [], actual[file] ?? [], out)
  }
  return out
}

// ── modes ───────────────────────────────────────────────────────────────────

function runInit(actual) {
  if (existsSync(BASELINE)) {
    console.error(
      '[complexity-ratchet] --init refuses to overwrite an existing baseline.\n' +
      'Use --update to lock in a burn-down; --init is only for seeding the first one.'
    )
    process.exit(1)
  }
  writeBaseline(actual)
  console.log(
    `[complexity-ratchet] baseline seeded — ${totalOf(actual)} violation(s) ` +
    `in ${Object.keys(actual).length} file(s).`
  )
}

function runUpdate(actual, regressions) {
  if (regressions.length > 0) {
    console.error(
      '[complexity-ratchet] --update refuses to grow the baseline.\n' +
      'Fix these first — the baseline records debt being paid down, never new debt:\n\n' +
      regressions.map((r) => '  ' + r).join('\n') + '\n'
    )
    process.exit(1)
  }
  writeBaseline(actual)
  console.log(
    `[complexity-ratchet] baseline updated — ${totalOf(actual)} violation(s) ` +
    `in ${Object.keys(actual).length} file(s).`
  )
}

function runCheck(actual, { regressions, improvements }) {
  if (regressions.length > 0) {
    console.error(
      `\n[complexity-ratchet] cognitive complexity regressed (limit is 15 — see CLAUDE.md):\n\n` +
      regressions.map((r) => '  ' + r).join('\n') +
      `\n\nExtract named helper functions, custom hooks, or named predicates, and use\n` +
      `guard clauses / early returns to flatten nesting. This is NOT waivable by\n` +
      `deleting a warning elsewhere — the --max-warnings budget is a separate,\n` +
      `fungible check, which is exactly why this one exists.\n`
    )
    process.exit(1)
  }

  if (improvements.length > 0) {
    console.error(
      `\n[complexity-ratchet] complexity IMPROVED but the baseline is stale:\n\n` +
      improvements.map((r) => '  ' + r).join('\n') +
      `\n\nLock it in so the reclaimed headroom cannot be silently refilled:\n` +
      `  node scripts/check-complexity-ratchet.mjs --update\n`
    )
    process.exit(1)
  }

  console.log(
    `[complexity-ratchet] OK — ${totalOf(actual)} baselined violation(s), none new or worse.`
  )
}

// ── main ────────────────────────────────────────────────────────────────────

const actual   = await collect()
const baseline = readBaseline()
const result   = diff(actual, baseline)

if (process.argv.includes('--init')) {
  runInit(actual)
} else if (process.argv.includes('--update')) {
  runUpdate(actual, result.regressions)
} else {
  runCheck(actual, result)
}
