import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { collectSourceFiles, read, rel, ROOT } from './scan'

// ============================================================================
// Public/token-route rate-limiting guardrail: CLAUDE.md's audit checklist
// states public token-guessable routes need their own rate limiter, "token
// entropy alone is not a substitute for throttling." proxy.ts implements
// this via TWO separately-maintained lists that must stay in sync by hand —
// TOKEN_ROUTES (routes the auth middleware treats as public/no-session) and
// rateLimiterForPathname() (which actually applies a limiter) — plus two
// BYPASS_ROUTES entries (accept-invite, crew-invite) that skip the
// TOKEN_ROUTES/rateLimiterForPathname path entirely and instead rate-limit
// inline in their own Server Action via inviteAcceptRatelimit. Nothing
// previously checked that either pairing stayed consistent; it's an easy
// mistake to add a new guessable-token surface to one list/mechanism and
// forget the other, since nothing forces the second half of the change.
//
// This does NOT check every public route in the app — BYPASS_ROUTES also
// contains webhooks (signature-verified), OAuth callbacks (state-validated,
// and still separately covered by rateLimiterForPathname's own
// '/api/integrations/...callback' branch), and the internal Inngest runner,
// none of which need this same guessable-token throttling and are excluded
// from this check by construction (only TOKEN_ROUTES and the two named
// invite-link BYPASS_ROUTES entries are in scope).
// ============================================================================

// Scans line-by-line to the array's closing `]` (a line that is just `]`),
// skipping comment lines. An earlier version sliced to the first `]` in the
// source, which a bracket inside a comment — e.g. a path like
// `app/g/kit/[media_kit_token]/media-kit-client.tsx` — silently truncated,
// making entries after that comment invisible to every check in this file.
function extractStringLiteralPrefixes(src: string, arrayVarName: string): string[] {
  const start = src.indexOf(`const ${arrayVarName} = [`)
  if (start === -1) return []

  const lines = src.slice(start).split('\n')
  const out: string[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === ']') break
    const stripped = line.trim()
    if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*')) continue
    for (const m of line.matchAll(/'([^']+)'/g)) out.push(m[1]!)
  }

  return out
}

/** Removes // and /* *\/ comments so prose can't match a source-pattern check. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

function extractRateLimiterFunctionBody(src: string): string {
  const start = src.indexOf('function rateLimiterForPathname(')
  if (start === -1) return ''
  const openBrace = src.indexOf('{', start)
  let depth = 1
  let i = openBrace + 1
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
  }
  return src.slice(openBrace, i)
}

describe('guardrail: public token-guessable routes stay rate-limited', () => {
  const proxySrc = read(join(ROOT, 'proxy.ts'))
  const tokenRoutes = extractStringLiteralPrefixes(proxySrc, 'TOKEN_ROUTES')
  const limiterBody = extractRateLimiterFunctionBody(proxySrc)

  it('finds a non-empty TOKEN_ROUTES list and a non-empty rateLimiterForPathname body (sanity: extraction is not silently broken)', () => {
    expect(tokenRoutes.length).toBeGreaterThan(3)
    expect(limiterBody.length).toBeGreaterThan(20)
  })

  it('every TOKEN_ROUTES prefix is covered by a rateLimiterForPathname branch', () => {
    const uncovered = tokenRoutes.filter((prefix) => !limiterBody.includes(`'${prefix}'`))

    expect(
      uncovered,
      [
        'proxy.ts\'s TOKEN_ROUTES lists a prefix with no matching branch in',
        'rateLimiterForPathname() — this route is publicly reachable with no',
        'session AND has no rate limiter, i.e. token-guessable and',
        'unthrottled. Add a pathname.startsWith(...) branch returning a',
        'limiter for it. Uncovered prefixes:',
        ...uncovered,
      ].join('\n')
    ).toEqual([])
  })

  it('the accept-invite and crew-invite bypass routes rate-limit inline (they skip TOKEN_ROUTES/rateLimiterForPathname entirely)', () => {
    const acceptInviteFiles = collectSourceFiles(['app/accept-invite'])
    const crewInviteFiles   = collectSourceFiles(['app/crew-invite'])

    const acceptInviteLimited = acceptInviteFiles.some((f) => read(f).includes('.limit('))
    const crewInviteLimited   = crewInviteFiles.some((f) => read(f).includes('.limit('))

    expect(
      { acceptInviteLimited, crewInviteLimited },
      'app/accept-invite and app/crew-invite are BYPASS_ROUTES (no session required) reachable by a guessable invite token, but rate-limit inline rather than via TOKEN_ROUTES/rateLimiterForPathname (see inviteAcceptRatelimit in lib/rate-limit.ts). One of them lost its inline .limit(...) call.'
    ).toEqual({ acceptInviteLimited: true, crewInviteLimited: true })
  })
})

// ============================================================================
// The block above compares TWO LISTS to each other, so it can only catch a
// route present in one and missing from the other. A route absent from BOTH is
// invisible to it — which is exactly how /api/guidebook/sponsor-checkout, a
// public unauthenticated endpoint that creates Stripe Checkout Sessions, ran
// unthrottled until the 2026-07-27 audit. This block closes that blind spot by
// starting from the filesystem instead of from either list.
// ============================================================================

describe('guardrail: every unauthenticated API route has SOME rate limiter', () => {
  // Exempt by construction, each for a reason that is not "we forgot".
  const EXEMPT = new Map<string, string>([
    ['app/api/webhooks/stripe/route.ts',         'signature-verified via stripe.webhooks.constructEvent'],
    ['app/api/webhooks/stripe-connect/route.ts', 'signature-verified via stripe.webhooks.constructEvent'],
    ['app/api/webhooks/[provider]/route.ts',     'signature-verified via lib/integrations/webhook-verification'],
    ['app/api/webhooks/telnyx/route.ts',         'signature-verified'],
    ['app/api/inngest/route.ts',                 'internal event runner, Inngest-signed'],
    ['app/api/health/route.ts',                  'no side effects, returns no data'],
  ])

  const AUTH_GATES = [
    'requireOrgMember', 'requireOrgRole', 'requireAuth',
    'requirePlatformAdmin', 'requireCrewMember', 'auth.getUser()',
  ]

  // NOTE: no \b before Limiter/Ratelimit. Every limiter in lib/rate-limit.ts is
  // named <thing>Limiter or <thing>Ratelimit, so a leading word boundary would
  // never match `guidebookRedeemLimiter` (the preceding character is a word
  // character) and this check would flag correctly-limited routes as offenders.
  const INLINE_LIMITER_RE = /Limiter\b|Ratelimit\b|\.limit\(/

  it('no unauthenticated API route lacks both a proxy prefix and an inline limiter', () => {
    const proxySrc    = read(join(ROOT, 'proxy.ts'))
    const limiterBody = extractRateLimiterFunctionBody(proxySrc)
    const prefixes    = [...limiterBody.matchAll(/startsWith\('([^']+)'\)/g)].map((m) => m[1]!)

    const offenders = collectSourceFiles(['app/api'])
      .map((f) => ({ file: f, path: rel(f) }))
      .filter(({ path }) => path.endsWith('/route.ts'))
      .filter(({ path }) => !EXEMPT.has(path))
      .filter(({ file, path }) => {
        const src = read(file)

        // A session is itself the gate — out of scope for this check.
        if (AUTH_GATES.some((g) => src.includes(g))) return false
        if (INLINE_LIMITER_RE.test(src)) return false

        const routePath = '/' + path.replace(/^app\//, '').replace(/\/route\.ts$/, '')
        return !prefixes.some((p) => routePath.startsWith(p))
      })
      .map(({ path }) => path)

    expect(
      offenders,
      [
        'These API routes are reachable without a session and have no rate',
        'limiter — neither an inline one nor a proxy.ts prefix in',
        'rateLimiterForPathname().',
        '',
        'Fix by adding a prefix to rateLimiterForPathname() (plus the matching',
        'TOKEN_ROUTES entry), or by applying a limiter inline the way',
        'app/api/guidebook/redeem/route.ts does. If the route is genuinely',
        'exempt, add it to EXEMPT above WITH a reason.',
        '',
        ...offenders,
      ].join('\n')
    ).toEqual([])
  })
})

// ============================================================================
// REACHABILITY (audit 2026-07-30, H-1)
//
// Both blocks above check that a limiter EXISTS for a route. Neither checks
// that an unauthenticated request can actually GET to that route — and those
// are different questions. /api/guidebook/sponsor-checkout and
// /api/guidebook/redeem each grew a correct inline limiter in the 2026-07-27
// audit, and both blocks above were green, while proxy.ts listed '/g/' in
// TOKEN_ROUTES and nothing at all for '/api/guidebook'. The config matcher
// covers /api/**, so a session-less POST to either route fell through to the
// "unauthenticated user hitting a protected route" branch and got a 307 to
// /login. Sponsor checkout and guest offer redemption — the only two callers,
// both from people who by definition have no FieldStay session — were dead,
// and the limiters were guarding doors nobody could reach.
//
// This block asks proxy.ts's OWN route tables what the middleware would do,
// for every route a limiter exists for. A limiter on an unreachable route is
// as much a bug as a reachable route with no limiter.
// ============================================================================

describe('guardrail: every rate-limited public route is actually reachable unauthenticated', () => {
  const proxySrc = read(join(ROOT, 'proxy.ts'))

  const bypassRoutes = extractStringLiteralPrefixes(proxySrc, 'BYPASS_ROUTES')
  const tokenRoutes  = extractStringLiteralPrefixes(proxySrc, 'TOKEN_ROUTES')
  const publicRoutes = extractStringLiteralPrefixes(proxySrc, 'PUBLIC_ROUTES')

  // Mirrors classifyRoute() in proxy.ts exactly — same three tables, same
  // order, same startsWith/equality semantics.
  function classify(pathname: string): 'bypass' | 'token' | 'public' | 'protected' {
    if (bypassRoutes.some((r) => pathname.startsWith(r))) return 'bypass'
    if (tokenRoutes.some((r)  => pathname.startsWith(r))) return 'token'
    if (publicRoutes.some((r) => pathname === r || pathname.startsWith(r + '/'))) return 'public'
    return 'protected'
  }

  it('sanity: all three proxy route tables were extracted', () => {
    expect(bypassRoutes.length).toBeGreaterThan(5)
    expect(tokenRoutes.length).toBeGreaterThan(3)
    expect(publicRoutes.length).toBeGreaterThan(3)
  })

  it('proxy.ts still models classification in exactly one place', () => {
    // If classifyRoute() disappears or stops consulting all three tables, the
    // `classify` mirror above has silently stopped mirroring anything.
    expect(proxySrc).toContain('export function classifyRoute(')
    const body = proxySrc.slice(proxySrc.indexOf('export function classifyRoute('))
    expect(body).toContain('BYPASS_ROUTES')
    expect(body).toContain('TOKEN_ROUTES')
    expect(body).toContain('PUBLIC_ROUTES')
  })

  it('no API route carries a rate limiter that only an authenticated caller could ever trigger', () => {
    // An auth gate means the route is MEANT to require a session — its
    // limiter is a per-user quota, not a public-surface throttle, so the
    // 307-to-login is correct behaviour and not a finding.
    const AUTH_GATES = [
      'requireOrgMember', 'requireOrgRole', 'requireAuth',
      'requirePlatformAdmin', 'requireCrewMember', 'auth.getUser()',
    ]

    const offenders = collectSourceFiles(['app/api'])
      .map((f) => ({ file: f, path: rel(f) }))
      .filter(({ path }) => path.endsWith('/route.ts'))
      .filter(({ file }) => /Limiter\b|Ratelimit\b|checkLimit\(/.test(read(file)))
      .filter(({ file }) => !AUTH_GATES.some((g) => read(file).includes(g)))
      .map(({ path }) => ({
        path,
        routePath: '/' + path.replace(/^app\//, '').replace(/\/route\.ts$/, ''),
      }))
      // A dynamic segment can't be resolved to a literal path; substitute a
      // placeholder so prefix matching still works.
      .map((r) => ({ ...r, routePath: r.routePath.replace(/\[[^\]]+\]/g, 'x') }))
      .filter((r) => classify(r.routePath) === 'protected')
      .map((r) => `${r.path}  →  ${r.routePath}`)

    expect(
      offenders,
      [
        'These API routes have a rate limiter but NO session gate, and',
        'proxy.ts classifies them as PROTECTED — so an unauthenticated caller',
        'never reaches them at all, they get a 307 to /login. Either the route',
        'is genuinely public (add its prefix to TOKEN_ROUTES, and a matching',
        'branch in rateLimiterForPathname), or it should have an auth gate and',
        'the limiter is describing a per-user quota.',
        '',
        'This is exactly the H-1 failure: a correct limiter on a dead route.',
        '',
        ...offenders,
      ].join('\n')
    ).toEqual([])
  })

  it('the two guidebook guest/sponsor APIs are reachable without a session', () => {
    // Named explicitly because these are the two H-1 regressions and their
    // callers (media-kit-client.tsx, guest-guidebook-view.tsx) are pages a
    // logged-out person is looking at.
    expect(classify('/api/guidebook/sponsor-checkout')).not.toBe('protected')
    expect(classify('/api/guidebook/redeem')).not.toBe('protected')
  })
})

// ============================================================================
// FAIL POLICY (audit 2026-07-30, M-1/M-2)
//
// Twelve hand-rolled `<limiter>.limit(...)` call sites had FOUR different
// behaviours when the limiter threw — fail-open-by-design, fail-open AND skip
// the write, fail-closed-as-500, and no catch at all — and none of them
// replicated proxy.ts's `upstashConfigured` guard, so every one paid
// @upstash/redis's ~4.3s retry against an undefined URL in any environment
// without the KV addon. checkLimit() in lib/rate-limit.ts makes the policy an
// explicit per-call argument and short-circuits when Upstash is unconfigured.
// It is only useful if it is the ONLY way to reach a limiter.
// ============================================================================

describe('guardrail: every limiter call goes through checkLimit()', () => {
  // Files owned by other concurrent workstreams at the time this guardrail
  // landed. SHRINK-ONLY — never add an entry. Each is a plain raw `.limit()`
  // that must be migrated to checkLimit(), not a justified exception.
  const PENDING_MIGRATION = new Map<string, string>([
    ['app/api/account/delete/route.ts',                'accountDeleteRatelimit — migrate to checkLimit(onError: "allow")'],
    ['app/accept-invite/[token]/actions.ts',           'inviteAcceptRatelimit — migrate to checkLimit(onError: "allow")'],
    ['app/crew-invite/[token]/actions.ts',             'inviteAcceptRatelimit — migrate to checkLimit(onError: "allow")'],
    ['app/(dashboard)/settings/integrations/actions.ts', 'integrationResyncLimiter — migrate to checkLimit(onError: "deny", it is an API-quota ceiling)'],
    ['lib/kroger/client.ts',                           'kroger*ApiLimiter — migrate to checkLimit(onError: "deny", it is an external quota ceiling)'],
  ])

  // `<something>Limiter.limit(` / `<something>Ratelimit.limit(` — a raw
  // limiter consultation. Deliberately does NOT match `.limit(50)` (Supabase
  // row limits) or `limiter.limit(identifier)` inside lib/rate-limit.ts, which
  // is checkLimit's own single implementation.
  function hasRawLimiterCall(src: string): boolean {
    const code = stripComments(src)
    // Only files that actually pull in a limiter can be consulting one, which
    // keeps Supabase's own numeric `.limit(50)` / `.limit(PAGE_SIZE)` row caps
    // out of scope everywhere else.
    // Static `from '@/lib/rate-limit'` OR a dynamic `await import('@/lib/rate-limit')`.
    if (!code.includes("'@/lib/rate-limit'") && !code.includes("'../rate-limit'")) return false
    // `<x>Limiter.limit(` / `<x>Ratelimit.limit(`, or a limiter received as a
    // parameter and called as `limiter.limit(identifier)`.
    return /\b\w*(?:Limiter|Ratelimit|limiter)\s*\n?\s*\.limit\(\s*[^0-9)]/.test(code)
  }

  it('no raw <limiter>.limit(...) outside lib/rate-limit.ts', () => {
    const offenders = collectSourceFiles(['app', 'lib', 'components'])
      .map((f) => ({ file: f, path: rel(f) }))
      .filter(({ path }) => path !== 'lib/rate-limit.ts')
      .filter(({ path }) => !PENDING_MIGRATION.has(path))
      .filter(({ file }) => hasRawLimiterCall(read(file)))
      .map(({ path }) => path)

    expect(
      offenders,
      [
        'These files consult an Upstash limiter directly instead of going',
        'through checkLimit() from lib/rate-limit.ts. Doing so re-opens both',
        'M-1 (the fail policy on a limiter error becomes whatever the',
        'surrounding try/catch happens to do — or a 500, if there is none) and',
        'M-2 (no upstashConfigured short-circuit, so every request in an env',
        'without the KV addon pays @upstash/redis\'s ~4.3s internal retry).',
        '',
        'Replace with:',
        '  const d = await checkLimit(theLimiter, key, { onError: "allow" | "deny", site: "..." })',
        '  if (!d.allowed) return <429>',
        '',
        'Choose onError deliberately: "allow" for abuse/enumeration limiters,',
        '"deny" for spend/quota ceilings (billed API calls, real money) —',
        'matching claimNudgeBudgetSlot\'s fail-CLOSED convention in CLAUDE.md.',
        '',
        ...offenders,
      ].join('\n')
    ).toEqual([])
  })

  it('every checkLimit() call names an explicit fail policy', () => {
    const offenders: string[] = []

    for (const file of collectSourceFiles(['app', 'lib', 'components'])) {
      const path = rel(file)
      if (path === 'lib/rate-limit.ts') continue
      const src = read(file)
      if (!src.includes('checkLimit(')) continue

      // Every call site's options object must carry onError. checkLimit's
      // signature requires it, so this is a belt-and-braces check that also
      // fails loudly if the option is ever made optional.
      const calls = src.split('checkLimit(').length - 1
      const policies = (src.match(/onError:\s*'(allow|deny)'/g) ?? []).length
      if (policies < calls) offenders.push(`${path} (${calls} call(s), ${policies} explicit policy/policies)`)
    }

    expect(
      offenders,
      'Every checkLimit() call must pass onError: "allow" | "deny" — the whole point is that the fail policy is never accidental.\n' + offenders.join('\n')
    ).toEqual([])
  })

  it('the PENDING_MIGRATION allowlist only shrinks', () => {
    // If a listed file no longer contains a raw limiter call, its entry is
    // stale and must be deleted — that is what makes this ratchet one-way.
    const stale = [...PENDING_MIGRATION.keys()].filter((p) => {
      try {
        return !hasRawLimiterCall(read(join(ROOT, p)))
      } catch {
        return true   // file gone → entry is stale
      }
    })

    expect(
      stale,
      'These PENDING_MIGRATION entries no longer have a raw limiter call (or no longer exist). Delete them — this allowlist is shrink-only.\n' + stale.join('\n')
    ).toEqual([])
  })
})

// ============================================================================
// WEBHOOK DEDUP CLAIMS MUST BE RELEASED ON A HANDLER THROW
//
// A webhook route that inserts its dedup row BEFORE running the handler has
// made a claim it must give back if the handler fails: the provider's retry
// carries the same event id / byte-identical body, hits the unique-violation
// branch, and is discarded as "already processed" even though nothing
// completed — the event is lost forever with a 200 on the wire.
// app/api/webhooks/[provider]/route.ts and .../stripe/route.ts both fixed
// this; .../stripe-connect/route.ts was missed in that sweep and shipped
// without it (audit 2026-07-30).
// ============================================================================

describe('guardrail: webhook dedup claims are released when the handler throws', () => {
  const DEDUP_TABLES = ['processed_webhooks', 'stripe_processed_events']

  it('every webhook route that claims a dedup row also deletes it', () => {
    const offenders: string[] = []

    for (const file of collectSourceFiles(['app/api/webhooks'])) {
      const src  = stripComments(read(file))
      const path = rel(file)

      const claimed = DEDUP_TABLES.filter((t) =>
        new RegExp(`from\\('${t}'\\)[\\s\\S]{0,200}?\\.insert\\(`).test(src)
      )
      if (claimed.length === 0) continue

      const releases = DEDUP_TABLES.some((t) =>
        new RegExp(`from\\('${t}'\\)[\\s\\S]{0,200}?\\.delete\\(`).test(src)
      )

      if (!releases) offenders.push(`${path} (claims ${claimed.join(', ')}, never deletes)`)
    }

    expect(
      offenders,
      [
        'These webhook routes INSERT a dedup row before running their handler',
        'but never DELETE it. A handler throw therefore leaves the claim',
        'committed, and the provider\'s retry is silently discarded as a',
        'duplicate — permanently dropping a real event behind a 200.',
        '',
        'Wrap the handler in try/catch, delete the claim row in the catch, and',
        'return 500 so the provider retries. See app/api/webhooks/stripe/route.ts.',
        '',
        ...offenders,
      ].join('\n')
    ).toEqual([])
  })
})

// ============================================================================
// NO `void` ON A LAZY POSTGREST BUILDER
//
// A PostgREST query builder is a lazy thenable: it issues its HTTP request
// only from inside then(). `void supabase.from(...).update(...)` therefore
// NEVER SENDS THE REQUEST — it reads like a deliberate fire-and-forget and is
// actually a no-op. This shipped in
// app/api/vendor-connect/[token]/onboard/route.ts, where the discarded update
// was the rollback that released a 'pending' mutex, leaving vendors
// permanently stuck in exactly the state the surrounding comment promised to
// prevent (audit 2026-07-30). Fire-and-forget needs `.then(...)` or a
// floating promise with a `.catch`, never `void` on the builder itself.
// ============================================================================

describe('guardrail: no `void` applied to a Supabase/PostgREST builder', () => {
  it('finds no `void <client>.from(...)` / `void <client>.rpc(...)` / `void <client>.storage`', () => {
    const RE = /\bvoid\s+\w+\s*(?:\n\s*)?\.\s*(?:from|rpc|storage)\b/

    const offenders = collectSourceFiles(['app', 'lib', 'components'])
      .filter((f) => RE.test(stripComments(read(f))))
      .map((f) => rel(f))

    expect(
      offenders,
      [
        'A PostgREST query builder is a LAZY THENABLE — it issues its HTTP',
        'request only from inside then(). `void <builder>` discards it without',
        'awaiting, so the query is never sent at all.',
        '',
        'Use `await` (preferred), or an explicit `.then(...)`/`.catch(...)` if',
        'the write really is fire-and-forget.',
        '',
        ...offenders,
      ].join('\n')
    ).toEqual([])
  })
})
