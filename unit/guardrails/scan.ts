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

export function collectSourceFiles(dirs: string[], exts = ['.ts', '.tsx']): string[] {
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
  return out
}

export function rel(file: string): string {
  // Normalize to forward slashes so allowlists compare identically on any OS
  return relative(ROOT, file).replaceAll('\\', '/')
}

export function read(file: string): string {
  return readFileSync(file, 'utf8')
}
