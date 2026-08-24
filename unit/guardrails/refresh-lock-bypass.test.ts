import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// EVERY CONTENDER TAKES THE REFRESH LOCK, INCLUDING THE CRON.
//
// All three refreshable providers rotate their refresh token on exchange, so
// two concurrent exchanges for one connection leave the LOSER's superseded
// token in Vault and the connection dies at the next refresh. `refresh-lock.ts`
// exists to serialize them.
//
// Each provider module therefore has two entry points: a locked wrapper, and
// the bare exchange it wraps. Only the module itself may call the bare one.
//
// integration-token-refresh-handler.ts called the bare ones for years, on the
// documented reasoning that its own
// `concurrency: { key: 'event.data.user_id + ":" + event.data.provider_id' }`
// already serialized it. That key serializes the handler against ITSELF. It
// says nothing about the sync functions, which are separate Inngest functions
// and take the Redis lock — so the single caller exempt from the lock was also
// the one most likely to collide, an hourly :00 refresh against sync crons that
// also fire at :00.
//
// A lock only works if every contender takes it, and "this caller is special"
// is how one stops being taken.
// ============================================================================

const ROOTS = [join(process.cwd(), 'lib'), join(process.cwd(), 'app')]

/** provider module that OWNS the bare function → the bare function's name. */
const BARE_EXCHANGES: Record<string, string> = {
  'lib/integrations/providers/hospitable-token.ts': 'refreshHospitableToken',
  'lib/integrations/providers/hostex-token.ts':     'refreshHostexToken',
  'lib/integrations/providers/kroger-token.ts':     'refreshKrogerToken',
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
  })
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

interface Finding { file: string; fn: string }

function scan(): Finding[] {
  const findings: Finding[] = []

  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const rel = file.slice(process.cwd().length + 1)
      // The owning module is allowed to call its own bare exchange — that is
      // precisely what the locked wrapper does.
      if (rel in BARE_EXCHANGES) continue

      const src = stripComments(readFileSync(file, 'utf8'))

      for (const fn of Object.values(BARE_EXCHANGES)) {
        // `refreshHospitableToken(` but NOT `refreshHospitableTokenLocked(`.
        if (new RegExp(`\\b${fn}\\s*\\(`).test(src)) findings.push({ file: rel, fn })
      }
    }
  }

  return findings
}

describe('guardrail: nothing bypasses the token refresh lock', () => {
  it('the bare exchange is called only by its own provider module', () => {
    const findings = scan()

    expect(
      findings,
      findings.length
        ? `These call the UNLOCKED refresh, so they can interleave an exchange ` +
          `with a concurrent sync and strand a superseded refresh token in Vault:\n` +
          findings.map((f) => `  ${f.file}: ${f.fn}(...)`).join('\n') +
          `\n\nUse the locked wrapper (refreshHospitableTokenLocked / ` +
          `refreshHostexTokenLocked / refreshKrogerTokenSingleFlight).`
        : '',
    ).toEqual([])
  })

  it('each locked wrapper is actually exported, or the rule above is unfollowable', () => {
    // A rule whose compliant path is not reachable teaches people to work
    // around it. All three were module-private until the cron needed them.
    const wrappers: Array<[string, string]> = [
      ['lib/integrations/providers/hospitable-token.ts', 'refreshHospitableTokenLocked'],
      ['lib/integrations/providers/hostex-token.ts',     'refreshHostexTokenLocked'],
      ['lib/integrations/providers/kroger-token.ts',     'refreshKrogerTokenSingleFlight'],
    ]

    for (const [file, wrapper] of wrappers) {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      expect(src, `${wrapper} must be exported`).toMatch(
        new RegExp(`export\\s+async\\s+function\\s+${wrapper}\\b`),
      )
    }
  })

  it('every locked wrapper actually acquires the lock', () => {
    // The wrapper being exported is not the same as it locking. This asserts
    // the thing the guardrail is actually about.
    for (const file of Object.keys(BARE_EXCHANGES)) {
      const src = stripComments(readFileSync(join(process.cwd(), file), 'utf8'))
      expect(src, `${file} must acquire the refresh lock`).toContain('acquireRefreshLock(')
      expect(src, `${file} must release the refresh lock`).toContain('releaseRefreshLock(')
    }
  })

  it('the scan fires on a bypass', () => {
    // A scan at zero because it is broken looks identical to a clean tree.
    const bypass = `
      import { refreshHospitableToken } from '@/lib/integrations/providers/hospitable-token'
      await refreshHospitableToken(user_id, external_user_id ?? '')
    `
    expect(/\brefreshHospitableToken\s*\(/.test(stripComments(bypass))).toBe(true)

    // ...and NOT on the locked wrapper, whose name has the bare one as a prefix.
    // `\b<fn>\s*\(` is what makes those distinguishable; a bare `includes()`
    // would call every compliant call site a violation.
    const compliant = `await refreshHospitableTokenLocked(user_id, external_user_id ?? '')`
    expect(/\brefreshHospitableToken\s*\(/.test(compliant)).toBe(false)
  })
})
