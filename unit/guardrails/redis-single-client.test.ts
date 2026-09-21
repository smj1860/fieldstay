import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read, readCode } from './scan'

// ============================================================================
// One Redis client, and every consumer asks whether Upstash exists first.
//
// There were FOUR independent clients — lib/rate-limit.ts, lib/sms/telnyx.ts,
// lib/weather/tomorrow.ts and lib/integrations/providers/ownerrez-api.ts —
// each written as
//
//   new Redis({ url: process.env.upstash_..._URL!, token: ...! })
//
// and exactly ONE of them (checkLimit) ever checked that those variables were
// set. The `!` is a lie in any environment without Upstash: the client
// constructs fine on undefined credentials and only fails at request time,
// building `${baseUrl}/pipeline` = "/pipeline", which undici rejects with
// `TypeError: Failed to parse URL from /pipeline`.
//
// Upstash's free plan is production-only here, so EVERY preview deploy has no
// credentials. The OwnerRez circuit breaker called Redis three times per
// connection per tick anyway, catching, logging and reporting each failure:
// 590 Sentry events over four days (CUSHION-D/E/H) for a condition that was
// knowable at boot and could never have succeeded.
//
// Three rules, all checked below:
//
//   1. `new Redis(...)` appears in lib/redis.ts and nowhere else. A second
//      construction site is a second connection pool AND a second chance to
//      forget the guard.
//   2. Every module that uses the client consults `upstashConfigured()` (or
//      uses `getRedisIfConfigured()`, which folds the check in). This is the
//      part that actually stops the noise — importing the shared client but
//      calling it unconditionally reproduces the bug exactly.
//   3. Every DIRECT `getRedis()` call site (not `getRedisIfConfigured()`) is
//      individually registered in DIRECT_CALL_SITES with why it is safe
//      without inspecting one on its own line. Rule 2 is a per-FILE check —
//      "does this file mention upstashConfigured() anywhere" — which is
//      exactly the gap this finding is about: lib/rate-limit.ts's module-load
//      `const redis = getRedis()` passes rule 2 because checkLimit() (a
//      DIFFERENT function, lower in the same file) happens to re-check
//      configuration before ever calling a method on that binding. The
//      invariant that redis' METHODS are never invoked without checking first
//      was true only by convention, not by anything this file enforced — a
//      brand-new direct getRedis() call added anywhere in an already-guarded
//      file would pass rule 2 silently. Rule 3 makes every such site an
//      explicit, reviewed decision instead.
//
// Not enforceable as a semgrep chokepoint rule: rule 2 is a per-MODULE
// property (does this file check anywhere?), not a per-expression one, which
// is the same reason the crew dead-letter and TOKEN_ROUTES invariants live
// here rather than in .semgrep/.
// ============================================================================

const OWNER = 'lib/redis.ts'

/** Files allowed to construct a client. Exactly one — never add to this. */
const CONSTRUCTION_SITES = new Set([OWNER])

/**
 * Every site that calls `getRedis()` directly rather than
 * `getRedisIfConfigured()`, with why it never reaches Upstash unguarded.
 * A NEW direct call site not listed here fails this guardrail even if its
 * file happens to mention `upstashConfigured()` elsewhere for an unrelated
 * reason — see the header comment for why that per-file check isn't enough
 * on its own.
 */
const DIRECT_CALL_SITES: Record<string, string> = {
  'lib/rate-limit.ts': "Only ever hands the client to `new Ratelimit({ redis, ... })`, which stores the reference and issues no request at construction time. Every actual `.limit()` call goes through checkLimit(), which re-checks upstashConfigured() first — see that function in this same file.",
  'lib/sms/telnyx.ts': 'Both call sites (in claimNudgeBudgetSlot() and releaseNudgeBudgetSlot()) are the first statement after an `if (!upstashConfigured()) return ...` guard in the same function, so neither is reached when unconfigured.',
  'lib/integrations/providers/ownerrez-api.ts': 'The one call site, in checkAndIncrementRequestBudget(), is the first statement after an `if (!upstashConfigured()) return` guard earlier in the same function.',
  'lib/inngest/functions/ownerrez/incremental-sync.ts': "All three call sites are inside the circuit-breaker read/reset helpers, which check upstashConfigured() first and return the breaker's default (closed) state when unconfigured — an Inngest step, so failing toward 'try anyway' is the safe direction, matching lib/redis.ts's own down-vs-unconfigured design note.",
}

function scan(): {
  constructors: string[]
  unguarded: string[]
  unregisteredDirect: string[]
  /** Every file with at least one direct getRedis() call — used to detect a stale DIRECT_CALL_SITES entry. */
  directCallFiles: Set<string>
} {
  const constructors: string[] = []
  const unguarded: string[] = []
  const unregisteredDirect: string[] = []
  const directCallFiles = new Set<string>()

  for (const file of collectSourceFiles(['lib', 'app'])) {
    const path = rel(file)
    // Comment-stripped: a header comment discussing getRedis()/
    // upstashConfigured() in prose (this file's own, or lib/weather/
    // tomorrow.ts's "getRedisIfConfigured() rather than getRedis():") must
    // not be read as a real call site — see CLAUDE.md's "a guardrail must
    // scan code, not prose".
    const code = readCode(file)

    if (/new\s+Redis\s*\(/.test(code) && !CONSTRUCTION_SITES.has(path)) {
      constructors.push(path)
    }

    if (path === OWNER) continue

    // Does this module actually reach the client?
    const usesClient = /\bgetRedis\s*\(/.test(code)
    if (!usesClient) continue

    // …and does it gate on configuration somewhere in the file?
    const guarded =
      /\bupstashConfigured\s*\(/.test(code) ||
      /\bgetRedisIfConfigured\s*\(/.test(code)

    if (!guarded) unguarded.push(path)

    // Every DIRECT getRedis() call must be a registered, individually-
    // justified site. `\bgetRedis\s*\(` does NOT match `getRedisIfConfigured(`
    // — the word boundary + immediate `(` requirement means "getRedis"
    // followed by "IfConfigured" never satisfies it — so this only catches
    // the direct form.
    const hasDirectCall = /\bgetRedis\s*\(/.test(code)
    if (hasDirectCall) {
      directCallFiles.add(path)
      if (!(path in DIRECT_CALL_SITES)) unregisteredDirect.push(path)
    }
  }

  return { constructors, unguarded, unregisteredDirect, directCallFiles }
}

describe('guardrail: a single Redis client, and no unguarded use of it', () => {
  const { constructors, unguarded, unregisteredDirect, directCallFiles } = scan()

  it('finds the consumer population (sanity: the scan is not silently empty)', () => {
    // If this drops to zero the matcher has broken and both assertions below
    // would pass vacuously. There are four real consumers today.
    const consumers = collectSourceFiles(['lib', 'app']).filter(
      (f) => rel(f) !== OWNER && /\bgetRedis(IfConfigured)?\s*\(/.test(read(f)),
    )
    expect(consumers.length).toBeGreaterThanOrEqual(3)
  })

  it('constructs a Redis client in lib/redis.ts and nowhere else', () => {
    expect(
      constructors,
      [
        'A Redis client is constructed outside lib/redis.ts. That is a second',
        'connection pool and a second place to forget the upstashConfigured()',
        'guard — which is how 590 preview-only Sentry events (CUSHION-D/E/H)',
        'happened. Import getRedis()/getRedisIfConfigured() from @/lib/redis',
        'instead. Offenders:',
        ...constructors,
      ].join('\n'),
    ).toEqual([])
  })

  it('every module that uses the client checks upstashConfigured() somewhere', () => {
    expect(
      unguarded,
      [
        'This module calls getRedis() but never asks whether Upstash is',
        'configured. Upstash is production-only on the current plan, so in',
        'every preview deploy that call builds the URL "/pipeline" and throws',
        'TypeError: Failed to parse URL from /pipeline — once per attempt,',
        'with a Sentry event each time.',
        '',
        'Either guard with upstashConfigured() and take your degraded path, or',
        'use getRedisIfConfigured() and branch on null. Decide deliberately',
        'which way to fail: the SMS nudge budget fails CLOSED (a spend ceiling',
        'must not silently become unlimited), the weather cache treats it as a',
        'miss, the OwnerRez breaker keeps its in-memory counter.',
        'Offenders:',
        ...unguarded,
      ].join('\n'),
    ).toEqual([])
  })

  it('every direct getRedis() call site is individually registered and justified', () => {
    expect(
      unregisteredDirect,
      [
        'This module calls getRedis() directly rather than',
        'getRedisIfConfigured(). Per-FILE guarding ("does this file mention',
        'upstashConfigured() anywhere") is not enough on its own — that is',
        'exactly how lib/rate-limit.ts\'s module-load `const redis =',
        'getRedis()` passed the previous version of this guardrail while',
        'depending on a DIFFERENT function (checkLimit) to guard the actual',
        'network call. Either switch to getRedisIfConfigured() and branch on',
        'null, or add an entry to DIRECT_CALL_SITES in this file explaining',
        'specifically why this call site never reaches Upstash unguarded.',
        'Offenders:',
        ...unregisteredDirect,
      ].join('\n'),
    ).toEqual([])
  })

  it('DIRECT_CALL_SITES stays free of entries the code no longer needs', () => {
    // Shrink-only, same ratchet shape as every other allowlist in this repo —
    // a stale entry silently stops meaning anything once its call site is
    // gone or switched to getRedisIfConfigured().
    const stale = Object.keys(DIRECT_CALL_SITES).filter((p) => !directCallFiles.has(p))
    expect(stale, `Stale DIRECT_CALL_SITES entries (no longer call getRedis() directly): ${stale.join(', ')}`).toEqual([])
  })
})
