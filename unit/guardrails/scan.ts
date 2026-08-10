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
