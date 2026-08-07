import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// A `'use server'` module may only export ASYNC FUNCTIONS.
//
// This shipped and broke a Vercel build. `app/crew/availability/actions.ts`
// gained two `export const` window constants so the page and the action could
// not drift on the range they show vs. accept — a good intention, in the wrong
// file.
//
// What makes it worth a guardrail rather than a lesson is HOW it failed:
//
//   • `npx tsc --noEmit` passed. The constraint is a Next.js compiler rule,
//     not a type rule.
//   • The full vitest suite passed. The test imported the constants directly,
//     which works fine outside the Next build.
//   • ESLint passed, check:ui-classes passed, both semgrep gates passed.
//   • The build error then names the WRONG export:
//         Export saveCrewAvailability doesn't exist in target module
//     …because the whole module fails to transform, so the error points at the
//     one export that was always there rather than the two that were added.
//
// So the entire local verification pass was green and the failure, when it
// arrived, described a symptom several steps removed from its cause.
//
// `export type` / `export interface` are NOT flagged and must not be: they are
// erased before the compiler sees them, and several action files legitimately
// export their own ActionState types (settings, owners, vendors, comms-log).
// The distinction this test encodes is runtime value vs. erased type.
// ============================================================================

const DIRS = ['app', 'lib', 'components']

/** `export const|let|var|class`, or a non-async `export function`. */
const RUNTIME_EXPORT = /^export\s+(?:(const|let|var|class)\s+(\w+)|function\s+(\w+))/gm

function offenders(): string[] {
  const found: string[] = []

  for (const file of collectSourceFiles(DIRS)) {
    const src = read(file)
    // Must be the module's own directive, not the inline `'use server'` that
    // marks a single function inside an otherwise ordinary module.
    if (!/^\s*(['"])use server\1/.test(src)) continue

    for (const m of src.matchAll(RUNTIME_EXPORT)) {
      const name = m[2] ?? m[3]!
      const line = src.slice(0, m.index).split('\n').length
      found.push(`${rel(file)}:${line} — export ${m[1] ?? 'function'} ${name}`)
    }
  }
  return found
}

describe("guardrail: a 'use server' module exports only async functions", () => {
  it('has no runtime-value exports in any Server Actions module', () => {
    expect(
      offenders().sort(),
      "A 'use server' module may only export async functions. A const/let/var/" +
      'class — or a non-async function — fails the NEXT BUILD, not tsc and not ' +
      'vitest, and the build error names a DIFFERENT export from the same file ' +
      '(the whole module fails to transform), so it reads as though an unrelated ' +
      'action disappeared. Move the value into a plain sibling module and import ' +
      'it from both sides — see app/crew/availability/window.ts. `export type` ' +
      'and `export interface` are fine here; they are erased before the compiler ' +
      'sees them.',
    ).toEqual([])
  })

  // Guards the guard: if the matcher stopped matching, the check above would
  // pass for a tree full of violations and look identical to a clean one.
  it('the matcher actually fires on the shape it is meant to catch', () => {
    const sample = `'use server'\nexport const LOOKBACK_DAYS = 30\nexport async function ok() {}\n`
    expect([...sample.matchAll(RUNTIME_EXPORT)].map((m) => m[2])).toEqual(['LOOKBACK_DAYS'])
  })

  it('does not flag the erased type exports several action files rely on', () => {
    const sample = `'use server'\nexport type ActionState = { error?: string }\nexport interface Input { id: string }\nexport async function ok() {}\n`
    expect([...sample.matchAll(RUNTIME_EXPORT)]).toEqual([])
  })
})
