// Shared source-file scanner for the guardrail suite.
//
// Guardrail tests assert cross-file/structural conventions that neither the
// type system nor per-file ESLint rules can express (e.g. "every service-role
// call site in app/ sits behind an authorization step"). They read the real
// source tree, so a violating PR fails `vitest run` in CI with a message that
// names the file and the rule.
//
// The system's meta-rule (see CLAUDE.md → Structural enforcement): when a new
// convention is worth writing down, it's worth a guardrail — add the test in
// the same PR that establishes the convention.

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

export const ROOT = join(__dirname, '..', '..')

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'out', 'build'])

/**
 * Both caches below exist because a guardrail that FLAKES is worse than no
 * guardrail: people learn to re-run it rather than read it.
 *
 * `use-server-exports` walks app + lib + components, and under the full
 * suite's parallel load that walk crossed vitest's default 5s test timeout —
 * 5181ms on the run that failed, 466ms for the same test in isolation. It
 * reported as a failure of the rule, not of the clock.
 *
 * The cost is almost entirely re-work. 27 guardrail files call
 * collectSourceFiles, most with one of four identical dir sets, and several
 * call it again per entry INSIDE a loop over their own EXCEPTIONS list — so a
 * three-entry allowlist meant three more full walks of app + lib. read() has
 * the same shape: several guardrails read every file in a tree that a sibling
 * check in the same file already read.
 *
 * Safe to cache: the guardrail suite only ever reads, and the tree is static
 * for the life of a run. Caches are per-worker (vitest isolates test files),
 * so this collapses the repetition within a file rather than across the suite
 * — which is where the repetition actually is.
 */
const fileListCache = new Map<string, string[]>()
const contentCache  = new Map<string, string>()

export function collectSourceFiles(dirs: string[], exts = ['.ts', '.tsx']): string[] {
  const key    = `${dirs.join('|')}::${exts.join('|')}`
  const cached = fileListCache.get(key)
  // A COPY, always. No caller sorts or splices the result today, but the cache
  // makes that a shared-mutable-state bug waiting to happen — one in-place
  // .sort() would silently reorder the list every later caller in the same
  // file sees. Copying a few thousand strings is free next to the walk it
  // replaces.
  if (cached) return [...cached]

  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (exts.some((e) => full.endsWith(e))) out.push(full)
    }
  }
  for (const d of dirs) walk(join(ROOT, d))

  fileListCache.set(key, out)
  return [...out]
}

export function rel(file: string): string {
  // Normalize to forward slashes so allowlists compare identically on any OS
  return relative(ROOT, file).replaceAll('\\', '/')
}

export function read(file: string): string {
  const cached = contentCache.get(file)
  if (cached !== undefined) return cached

  const src = readFileSync(file, 'utf8')
  contentCache.set(file, src)
  return src
}

// ─────────────────────────────────────────────────────────────────────────────
// SCANNING CODE RATHER THAN PROSE
//
// A guardrail that greps raw source is reading the comments too, and that
// breaks it in two directions — both found by a sweep on 2026-08-25 that
// stripped every comment in app/lib/components and re-ran the suite:
//
//  - A REQUIRED pattern is satisfied by a comment. `commercial-email-optout`
//    asserted `toContain('FAILS CLOSED')`; flipping the CAN-SPAM helper from
//    fail-closed to fail-OPEN left all nine of its tests green, because the
//    phrase lives in the JSDoc above the function.
//  - An EXEMPTING pattern is satisfied by a comment. `inngest-insert-idempotency`
//    treats a nearby `onConflict` as proof an insert is dedup-guarded, and was
//    waving through an insert whose only `onConflict` was in a comment 85 lines
//    away — so any file that merely MENTIONS the word grants its inserts
//    immunity.
//  - A BUDGET is consumed by a comment. `sensitive-data-logging` matches a
//    300-character window after `logAuditEvent(`; a 52-character comment inside
//    one call pushed it to 323 and made the whole call — which writes a money
//    figure into audit metadata — invisible to the scan.
//
// `readCode` is the fix for all three. Comments are removed, NEWLINES ARE KEPT,
// so `src.slice(0, i).split('\n').length` still gives the real line number and
// every offender key stays stable — but comment characters no longer count
// toward a window or satisfy a match.
// ─────────────────────────────────────────────────────────────────────────────

const codeCache = new Map<string, string>()

/** Source with comments removed and line numbers preserved. */
export function readCode(file: string): string {
  const cached = codeCache.get(file)
  if (cached !== undefined) return cached

  const stripped = stripComments(read(file))
  codeCache.set(file, stripped)
  return stripped
}

/**
 * Character-level, because a regex cannot do this correctly.
 *
 * A URL in a string, and a regex literal built out of escaped slashes and
 * stars, both contain what looks like a comment opener — so a naive
 * line-comment regex deletes real code and produces findings indistinguishable
 * from the genuine ones. Strings, template literals (including nested
 * interpolations) and regex literals are all tracked.
 *
 * (Those two examples are described rather than quoted: a block comment cannot
 * contain the sequence that ends it, which is the same parsing problem one
 * level up, and it took this file down on first run.)
 *
 * Conservative by construction: it only ever DELETES comment text and never
 * rewrites anything else, so a misread regex literal costs a missed comment
 * rather than a corrupted file. Verified by stripping all 688 source files and
 * confirming `tsc --noEmit` still passes.
 */
export function stripComments(src: string): string {
  const out: string[] = []
  let i = 0

  while (i < src.length) {
    // Each consumer returns the index just past what it handled, or null when
    // this position is not its business. Split out of one long branch chain
    // because that scored 29 on cognitive complexity against this repo's own
    // limit of 15 — a limit that happens not to be ENFORCED here, since
    // eslint.config.mjs scopes the sonarjs rules to app/lib/components. The
    // rule applies to the enforcement layer too.
    const next = consumeComment(src, i, out)
      ?? consumeQuoted(src, i, out)
      ?? consumeRegexLiteral(src, i, out)

    if (next !== null) {
      i = next
      continue
    }

    out.push(src[i]!)
    i++
  }
  return out.join('')
}

/**
 * A line or block comment, dropped. Returns null if this is not a comment.
 *
 * A line comment leaves its terminating newline behind for the main loop; a
 * block comment emits ONLY the newlines it spanned. Keeping its blanks too
 * would preserve column positions but leave a windowed scanner's character
 * budget just as consumed as before — which is half the point of this module.
 */
function consumeComment(src: string, i: number, out: string[]): number | null {
  if (src[i] !== '/') return null

  if (src[i + 1] === '/') {
    let j = i
    while (j < src.length && src[j] !== '\n') j++
    return j
  }

  if (src[i + 1] === '*') {
    const end  = src.indexOf('*/', i + 2)
    const stop = end === -1 ? src.length : end + 2
    for (let k = i; k < stop; k++) if (src[k] === '\n') out.push('\n')
    return stop
  }

  return null
}

/** A string or template literal, copied verbatim. Null if not a quote. */
function consumeQuoted(src: string, i: number, out: string[]): number | null {
  const c = src[i]
  if (c !== '"' && c !== "'" && c !== '`') return null
  return copyQuoted(src, i, c, out)
}

/** A regex literal, copied verbatim. Null if this `/` is division. */
function consumeRegexLiteral(src: string, i: number, out: string[]): number | null {
  if (src[i] !== '/' || !regexAllowed(out)) return null

  const end = regexEnd(src, i)
  if (end === -1) return null

  out.push(src.slice(i, end))
  return end
}

/** Copies a string or template literal verbatim, returning the next index. */
function copyQuoted(src: string, start: number, quote: string, out: string[]): number {
  let i = start
  let depth = 0
  out.push(src[i]!)
  i++

  while (i < src.length) {
    const ch = src[i]!
    if (ch === '\\') {
      out.push(ch)
      if (i + 1 < src.length) out.push(src[i + 1]!)
      i += 2
      continue
    }
    // `${` … `}` inside a template can itself contain quotes and comments; the
    // depth counter keeps the closing backtick from being found early.
    if (quote === '`' && ch === '$' && src[i + 1] === '{') {
      depth++
      out.push('$', '{')
      i += 2
      continue
    }
    if (quote === '`' && depth > 0 && ch === '}') {
      depth--
      out.push(ch)
      i++
      continue
    }
    out.push(ch)
    i++
    if (ch === quote && depth === 0) break
  }
  return i
}

// `<` and `>` are deliberately NOT here. They are legitimate regex predecessors
// in plain TS, but in TSX `</div>` would then start a "regex" scan — and the
// cost of missing `a < /re/.test(x)` is nil next to mis-scanning every closing
// tag in the component tree.
const REGEX_PREV = new Set('(,=:[!&|?{};+-*%~^\n'.split(''))
const REGEX_PREV_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await',
])

/** Whether a `/` here opens a regex literal rather than being division. */
function regexAllowed(out: string[]): boolean {
  let i = out.length - 1
  while (i >= 0 && (out[i] === ' ' || out[i] === '\t')) i--
  if (i < 0) return true

  const c = out[i]!
  if (REGEX_PREV.has(c)) return true

  let j = i
  while (j >= 0 && /[\w$]/.test(out[j]!)) j--
  return REGEX_PREV_WORDS.has(out.slice(j + 1, i + 1).join(''))
}

/** Index just past a regex literal's closing delimiter and flags, or -1. */
function regexEnd(src: string, start: number): number {
  let i = start + 1
  let inClass = false

  while (i < src.length) {
    const ch = src[i]!
    if (ch === '\\') { i += 2; continue }
    if (ch === '\n') return -1              // unterminated: it was division
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      i++
      while (i < src.length && 'dgimsuvy'.includes(src[i]!)) i++
      return i
    }
    i++
  }
  return -1
}
