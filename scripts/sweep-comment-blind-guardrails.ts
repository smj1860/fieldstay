#!/usr/bin/env tsx
/**
 * Finds guardrails that are reading COMMENTS instead of code.
 *
 * ── The defect class ────────────────────────────────────────────────────────
 *
 * Most guardrails in unit/guardrails/ are text scanners over the real source
 * tree. A scanner that greps raw source is reading the prose too, and that
 * breaks it three ways — all three found live on 2026-08-25:
 *
 *   REQUIRED pattern satisfied by a comment.
 *     commercial-email-optout asserted the source contained the phrase
 *     "FAILS CLOSED". Flipping the CAN-SPAM helper from fail-closed to
 *     fail-OPEN — a real consent regression — left all nine of its tests green,
 *     because the phrase lives in the JSDoc above the function.
 *
 *   EXEMPTING pattern satisfied by a comment.
 *     inngest-insert-idempotency treats a nearby `onConflict` as proof an
 *     insert is dedup-guarded. An unguarded insert was passing because the word
 *     appeared in a comment 85 lines above it — so any file that MENTIONS the
 *     word granted its inserts immunity.
 *
 *   BUDGET consumed by a comment.
 *     sensitive-data-logging matches a 300-character window after
 *     `logAuditEvent(`. A 52-character comment inside one call pushed it to 323
 *     and hid the whole call — which was writing a money figure into audit
 *     metadata, the exact class that guardrail exists to catch.
 *
 * ── How the sweep works ─────────────────────────────────────────────────────
 *
 * Strip every comment from app/, lib/ and components/, then run the guardrail
 * suite. A guardrail that PASSES on the real tree and FAILS on the stripped one
 * was, somewhere, depending on comment text.
 *
 * Not every hit is a defect. Two guardrails read comments ON PURPOSE, because
 * the comment IS the artifact:
 *   - inngest-history-secrets honours an `inngest-history-safe:` annotation,
 *     the same way eslint honours `eslint-disable`.
 *   - redemption-dedup-pairing requires the route to NAME the index it depends
 *     on, so a grep for the index finds its consumer.
 * Those are expected failures here; every other hit needs triage.
 *
 * ── Why this is a script and not a CI gate ──────────────────────────────────
 *
 * It rewrites the working tree, which is fine to do deliberately and wrong to
 * do on every push. It also takes two full guardrail runs. Run it when adding a
 * scanner-style guardrail, or when auditing.
 *
 * ── Restore is from MEMORY, not from git ────────────────────────────────────
 *
 * Originals are held in a Map and written back in a `finally`, with SIGINT and
 * SIGTERM handled so Ctrl-C restores too. The earlier version restored with
 * `git checkout -- app lib components`, which forced it to refuse to run on a
 * dirty tree: that command discards uncommitted work, so it could not be
 * allowed anywhere near one. Restoring exactly what was read back is both safer
 * and unrestricted — a dirty tree is now fine.
 *
 * It also removes the only reason this script shelled out to `git`. Nothing
 * here resolves a binary through PATH any more: the guardrail run is spawned as
 * `process.execPath` against vitest's resolved entry point, so neither the node
 * binary nor the test runner can be shadowed by a PATH entry.
 *
 * Residual risk, stated rather than hidden: a hard kill (SIGKILL, power loss)
 * between stripping and restoring leaves the tree stripped. Recover with
 * `git checkout -- app lib components`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The SAME stripper the guardrails use. If the sweep had its own, the two could
// disagree and the sweep would be testing something the suite never sees.
import { stripComments } from '../unit/guardrails/scan'

const ROOT = join(__dirname, '..')
const DIRS = ['app', 'lib', 'components']
const SKIP = new Set(['node_modules', '.next', '.git', 'out', 'build'])

/**
 * Vitest's own entry, resolved through node's module resolution rather than
 * found on PATH. Paired with `process.execPath` below this pins BOTH halves of
 * the spawn: the interpreter and the script it runs.
 */
const VITEST_ENTRY = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

/** Guardrails that read comments deliberately — see the header. */
const EXPECTED: Record<string, string> = {
  'unit/guardrails/inngest-history-secrets.test.ts':
    'Honours the `inngest-history-safe:` annotation, which is a comment by design '
    + '— the same contract as an eslint-disable line.',
  'unit/guardrails/redemption-dedup-pairing.test.ts':
    'Requires the route to NAME the unique index it depends on in a comment, so '
    + 'that grepping for the index finds its consumer. The comment is the artifact.',
}

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry) || entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full)
    }
  }
  for (const d of DIRS) walk(join(ROOT, d))
  return out
}

/**
 * Guardrail test files that failed, from vitest's output.
 *
 * THE SUMMARY LINE IS CHECKED FIRST, and that is not defensive padding. The
 * first version of this passed `--reporter=basic`, which vitest 4 does not have
 * — the run died before executing a single test, the FAIL regex matched
 * nothing, and the sweep printed "no guardrail depends on comment text". A
 * tool built to find checks that pass without looking, passing without
 * looking. Anything short of a real run is now a hard error, not a clean bill.
 */
function runGuardrails(): Set<string> {
  let output: string
  try {
    output = execFileSync(process.execPath, [VITEST_ENTRY, 'run', 'unit/guardrails/'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    // A non-zero exit is the NORMAL case here — failures are the signal.
    const e = err as { stdout?: string; stderr?: string }
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }

  const summary = /Test Files\s+.*?\((\d+)\)/.exec(output)
  if (!summary || Number(summary[1]) === 0) {
    throw new Error(
      'vitest did not report a test-file count, so no tests actually ran. Refusing to\n'
      + 'interpret an empty result as a pass. Output tail:\n'
      + output.split('\n').slice(-25).join('\n'),
    )
  }

  const failed = new Set<string>()
  for (const line of output.split('\n')) {
    const m = /^\s*FAIL\b.*?(unit\/guardrails\/[\w.-]+\.test\.ts)/.exec(line)
    if (m) failed.add(m[1]!)
  }
  return failed
}

/** Originals of every file this run rewrote, keyed by absolute path. */
const originals = new Map<string, string>()

function restore(): void {
  for (const [file, src] of originals) writeFileSync(file, src, 'utf8')
  originals.clear()
}

/**
 * Ctrl-C must put the tree back. Without this the `finally` never runs on a
 * signal and the developer is left with a comment-stripped checkout and no
 * indication why.
 */
function onSignal(signal: NodeJS.Signals): void {
  console.log(`\n[sweep] ${signal} — restoring before exit…`)
  restore()
  process.exit(130)
}

function main(): number {
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  console.log('[sweep] baseline: running guardrails against the real tree…')
  const baselineFailures = runGuardrails()
  if (baselineFailures.size > 0) {
    console.error('[sweep] The guardrail suite is ALREADY failing. Fix that first — this sweep\n'
      + '        works by comparing against a green baseline.')
    for (const f of baselineFailures) console.error(`          ${f}`)
    return 2
  }

  const files = sourceFiles()
  console.log(`[sweep] stripping comments from ${files.length} files…`)

  let failures: Set<string>
  try {
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const out = stripComments(src)
      if (out === src) continue
      // Recorded BEFORE the write, so a throw mid-loop still restores every
      // file already rewritten.
      originals.set(f, src)
      writeFileSync(f, out, 'utf8')
    }

    console.log('[sweep] re-running guardrails against the stripped tree…')
    failures = runGuardrails()
  } finally {
    console.log('[sweep] restoring…')
    restore()
  }

  const findings = [...failures].filter((f) => !(f in EXPECTED))
  const expected = [...failures].filter((f) => f in EXPECTED)

  console.log('')
  for (const f of expected) console.log(`  [expected] ${f}\n             ${EXPECTED[f]}`)

  if (findings.length === 0) {
    console.log('\n[sweep] OK — no guardrail depends on comment text.')
    return 0
  }

  console.log('\n[sweep] COMMENT-DEPENDENT GUARDRAILS:\n')
  for (const f of findings) console.log(`  ${f}`)
  console.log('\n  Each of these passes on the real tree and fails without comments, so some\n'
    + '  assertion in it is reading prose. Switch the scanner to readCode() from\n'
    + '  unit/guardrails/scan.ts, or replace the grep with a behavioural assertion.\n'
    + '  If the comment genuinely IS the artifact, add it to EXPECTED above with the\n'
    + '  reason.')
  return 1
}

process.exit(main())
