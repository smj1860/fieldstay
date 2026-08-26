import { describe, it, expect } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT, read, readCode } from './scan'

// ============================================================================
// CLAUDE.md NAMES ONLY HELPERS THAT EXIST.
//
// Found 2026-08-25: the file told you three times to use `createServerClient()`
// from `lib/supabase/server.ts`. That module exports `createClient`,
// `createReauthClient`, `createServiceClient` and `adminFetch` — never
// `createServerClient`. The name was plausible precisely because it is real:
// it belongs to `@supabase/ssr`, which that module imports and wraps on its
// first line.
//
// The cost is not tidiness. CLAUDE.md is the onboarding artifact, and the
// failure lands at the worst moment — you follow the documented call, get
// "has no exported member named 'createServerClient'", and TypeScript helpfully
// suggests `createServiceClient`, which is the SERVICE ROLE client. A doc bug
// whose error message points at the RLS bypass is worth a guardrail.
//
// This checks the claim FORM that carries an import instruction —
// "`fn()` from `lib/path.ts`" — rather than every backticked identifier. Prose
// mentions a lot of names in passing; a "from <module>" is a directive.
// ============================================================================

/**
 * Claims of the shape: `someHelper()` from `lib/some/module.ts`
 *
 * The path group deliberately excludes `@supabase/ssr` and friends — an
 * external package's export surface is not this repo's to verify, and line 30's
 * `createServerClient from @supabase/ssr` is CORRECT and must stay.
 */
const CLAIM = /`([a-zA-Z_][a-zA-Z0-9_]*)\(\)?`[^`\n]{0,20}from `((?:lib|app)\/[a-zA-Z0-9/_.-]+)`/g

interface Claim { symbol: string; module: string; line: number }

function claims(): Claim[] {
  const doc = read('CLAUDE.md')
  const out: Claim[] = []
  CLAIM.lastIndex = 0

  let m: RegExpExecArray | null
  while ((m = CLAIM.exec(doc))) {
    out.push({
      symbol: m[1]!,
      module: m[2]!,
      line:   doc.slice(0, m.index).split('\n').length,
    })
  }
  return out
}

/**
 * Resolves a doc path to a real FILE, tolerating a missing extension.
 *
 * The isFile check is load-bearing, not defensive: CLAUDE.md writes
 * "`requireOrgMember()` from `lib/auth`" and `lib/auth` is a DIRECTORY, so an
 * existence test alone returns the directory and the read throws EISDIR.
 * Extension-less paths have to fall through to `<dir>/index.ts`.
 */
function resolveModule(module: string): string | null {
  for (const candidate of [module, `${module}.ts`, `${module}.tsx`, `${module}/index.ts`]) {
    const full = join(ROOT, candidate)
    if (existsSync(full) && statSync(full).isFile()) return full
  }
  return null
}

/**
 * Whether the module exports the symbol.
 *
 * readCode, so a name that appears only in a comment cannot satisfy this —
 * which is exactly the trap this suite spent 2026-08-25 removing from four
 * other guardrails. `lib/supabase/server.ts` MENTIONS `createServerClient`
 * repeatedly in its own prose while not exporting it, so a raw-text scan here
 * would have reported the original bug as fine.
 */
function exportsSymbol(file: string, symbol: string): boolean {
  const src = readCode(file)
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${symbol}\\b`),
    new RegExp(`export\\s+(?:const|let|class|type|interface)\\s+${symbol}\\b`),
    new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`),
  ]
  return patterns.some((re) => re.test(src))
}

describe('guardrail: every helper CLAUDE.md tells you to import actually exists', () => {
  it('finds the claims at all — a zero-claim scan would pass vacuously', () => {
    // Without this, rewording the doc so no claim matches turns the whole
    // guardrail green while checking nothing.
    expect(claims().length).toBeGreaterThanOrEqual(4)
  })

  it('names a module that exists, for every claim', () => {
    for (const { symbol, module, line } of claims()) {
      expect(
        resolveModule(module),
        `CLAUDE.md:${line} says \`${symbol}()\` comes from \`${module}\`, which is not a file.`,
      ).not.toBeNull()
    }
  })

  it('names a symbol that module really exports, for every claim', () => {
    for (const { symbol, module, line } of claims()) {
      const file = resolveModule(module)
      if (!file) continue   // reported by the test above

      expect(
        exportsSymbol(file, symbol),
        `CLAUDE.md:${line} tells you to use \`${symbol}()\` from \`${module}\`, but that `
        + 'module does not export it. Someone will follow the instruction, get a '
        + "TypeScript error, and take whichever near-miss the compiler suggests — which "
        + 'is how `createServerClient` pointed at `createServiceClient`, the service-role '
        + 'client. Fix the doc or export the symbol.',
      ).toBe(true)
    }
  })
})
