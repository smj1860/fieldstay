import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { collectSourceFiles, rel, read, ROOT } from './scan'

// ============================================================================
// Guardrail: a Next.js `export const config` must be statically parsable.
//
// Next.js reads this object at BUILD time without evaluating it, so every
// value has to be a literal. A perfectly ordinary refactor —
//
//   const MIDDLEWARE_MATCHER = '/((?!_next/static|…).*)'
//   export const config = { matcher: [MIDDLEWARE_MATCHER] }
//
// — type-checks, lints, passes every unit test and both semgrep gates, and
// then fails the build:
//
//   Next.js can't recognize the exported `config` field in route.
//   Entry `matcher[0]` need to be static strings or static objects.
//
// This shipped on 2026-08-10 and broke the Vercel preview. It is the same
// class as the 'use server' export rule that use-server-exports.test.ts
// guards: a compiler constraint that NOTHING in the local verification pass
// can see, because nothing local runs `next build`. The failure also arrives
// with a build error rather than anywhere near the change that caused it.
//
// The pull toward extracting that constant is real — a test wants to assert
// against the same pattern the runtime uses, and duplicating a regex is
// obviously worse. The right answer is for the test to read `config.matcher[0]`
// (see unit/lib/proxy-matcher.test.ts), which keeps one source of truth
// without moving it out of the literal.
// ============================================================================

/** `export const config = { … }`, captured through the balanced braces. */
function configObject(src: string): string | null {
  const m = /export\s+const\s+config\s*(?::[^=]+)?=\s*\{/.exec(src)
  if (!m) return null

  const open = src.indexOf('{', m.index)
  let depth = 0
  let inString: string | null = null

  for (let i = open; i < src.length; i++) {
    const ch = src[i] as string
    if (inString) {
      if (ch === '\\') { i++; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue }
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

/** The raw text of `matcher: [ … ]` inside a config object, if present. */
function matcherArray(configSrc: string): string | null {
  const m = /matcher\s*:\s*\[/.exec(configSrc)
  if (!m) return null

  const open = configSrc.indexOf('[', m.index)
  let depth = 0
  let inString: string | null = null

  for (let i = open; i < configSrc.length; i++) {
    const ch = configSrc[i] as string
    if (inString) {
      if (ch === '\\') { i++; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return configSrc.slice(open + 1, i)
    }
  }
  return null
}

/**
 * Every element of the array is a quoted literal.
 *
 * Strips string literals first, then asserts nothing identifier-shaped is
 * left. That catches `[MIDDLEWARE_MATCHER]`, `[...PATTERNS]` and
 * `[buildMatcher()]` alike, without needing to enumerate the ways a value can
 * fail to be static.
 */
function hasNonLiteralEntry(arraySrc: string): boolean {
  const withoutStrings = arraySrc
    .replace(/'(?:[^'\\]|\\.)*'/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '')
    .replace(/`(?:[^`\\]|\\.)*`/g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  return /[A-Za-z_$]/.test(withoutStrings)
}

/**
 * Files Next.js actually compiles a `config` export out of: the app tree, and
 * root-level modules like proxy.ts / instrumentation.ts.
 *
 * Deliberately NOT the whole repo. The first version scanned `.` recursively
 * and reported THIS FILE — its own fixture string `matcher: [MIDDLEWARE_MATCHER]`,
 * which exists to prove the check works. A guardrail that flags the example of
 * the defect it guards teaches people to delete the example.
 */
function compiledFiles(): string[] {
  const rootLevel = readdirSync(ROOT)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(ROOT, f))
    .filter((f) => statSync(f).isFile())

  return [...collectSourceFiles(['app', 'lib'], ['.ts']), ...rootLevel]
}

interface Finding { file: string; matcher: string }

function findOffenders(): Finding[] {
  const offenders: Finding[] = []

  for (const file of compiledFiles()) {
    const key = rel(file)
    const src = read(file)
    const cfg = configObject(src)
    if (!cfg) continue

    const arr = matcherArray(cfg)
    if (!arr) continue
    if (!hasNonLiteralEntry(arr)) continue

    offenders.push({ file: key, matcher: arr.trim().slice(0, 120) })
  }

  return offenders
}

describe('guardrail: Next.js `export const config` stays statically parsable', () => {
  it('every config.matcher entry is a string literal, not a reference', () => {
    const offenders = findOffenders()
    expect(
      offenders,
      offenders.length
        ? 'These config.matcher arrays contain something Next.js cannot parse at build time:\n' +
          offenders.map((o) => `  - ${o.file}: [${o.matcher}]`).join('\n') +
          '\n\nNext.js reads `export const config` WITHOUT evaluating it, so a variable, ' +
          'spread or function call fails the build with "Entry `matcher[0]` need to be ' +
          'static strings or static objects" — after passing tsc, lint, vitest and semgrep, ' +
          'because nothing local runs `next build`. Inline the literal. If a test needs the ' +
          'same pattern, read `config.matcher[0]` rather than extracting a constant ' +
          '(unit/lib/proxy-matcher.test.ts is the reference).'
        : '',
    ).toEqual([])
  })

  it('the matcher this repo actually ships is found and is literal', () => {
    // A parser that silently matched nothing would make the check above pass
    // for any tree. This pins that it still locates the real one.
    const proxy = compiledFiles().find((f) => rel(f) === 'proxy.ts')
    expect(proxy, 'proxy.ts should be scanned').toBeDefined()

    const arr = matcherArray(configObject(read(proxy as string)) as string)
    expect(arr).toBeTruthy()
    expect(hasNonLiteralEntry(arr as string)).toBe(false)
  })

  it('recognises the exact shape that broke the build', () => {
    const bad  = "export const config = {\n  matcher: [MIDDLEWARE_MATCHER],\n}"
    const good = "export const config = {\n  matcher: ['/((?!_next/static).*)'],\n}"

    expect(hasNonLiteralEntry(matcherArray(configObject(bad) as string) as string)).toBe(true)
    expect(hasNonLiteralEntry(matcherArray(configObject(good) as string) as string)).toBe(false)
  })
})
