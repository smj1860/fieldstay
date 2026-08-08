import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

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
// Two rules, both checked below:
//
//   1. `new Redis(...)` appears in lib/redis.ts and nowhere else. A second
//      construction site is a second connection pool AND a second chance to
//      forget the guard.
//   2. Every module that uses the client consults `upstashConfigured()` (or
//      uses `getRedisIfConfigured()`, which folds the check in). This is the
//      part that actually stops the noise — importing the shared client but
//      calling it unconditionally reproduces the bug exactly.
//
// Not enforceable as a semgrep chokepoint rule: rule 2 is a per-MODULE
// property (does this file check anywhere?), not a per-expression one, which
// is the same reason the crew dead-letter and TOKEN_ROUTES invariants live
// here rather than in .semgrep/.
// ============================================================================

const OWNER = 'lib/redis.ts'

/** Files allowed to construct a client. Exactly one — never add to this. */
const CONSTRUCTION_SITES = new Set([OWNER])

function scan(): { constructors: string[]; unguarded: string[] } {
  const constructors: string[] = []
  const unguarded: string[] = []

  for (const file of collectSourceFiles(['lib', 'app'])) {
    const path = rel(file)
    const src  = read(file)

    if (/new\s+Redis\s*\(/.test(src) && !CONSTRUCTION_SITES.has(path)) {
      constructors.push(path)
    }

    if (path === OWNER) continue

    // Does this module actually reach the client?
    const usesClient = /\bgetRedis\s*\(/.test(src)
    if (!usesClient) continue

    // …and does it gate on configuration somewhere in the file?
    const guarded =
      /\bupstashConfigured\s*\(/.test(src) ||
      /\bgetRedisIfConfigured\s*\(/.test(src)

    if (!guarded) unguarded.push(path)
  }

  return { constructors, unguarded }
}

describe('guardrail: a single Redis client, and no unguarded use of it', () => {
  const { constructors, unguarded } = scan()

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
})
