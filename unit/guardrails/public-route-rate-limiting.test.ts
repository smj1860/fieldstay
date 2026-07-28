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

function extractStringLiteralPrefixes(src: string, arrayVarName: string): string[] {
  const start = src.indexOf(`const ${arrayVarName} = [`)
  if (start === -1) return []
  const end = src.indexOf(']', start)
  const body = src.slice(start, end)
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
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
