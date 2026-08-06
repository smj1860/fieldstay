import { describe, it, expect } from 'vitest'
import { safeNextPath } from '@/lib/auth/safe-redirect'

// ============================================================================
// Post-auth "?next=" was an open redirect. Both auth forms read it straight out
// of searchParams and handed it to router.push() with NO validation:
//
//     https://app.fieldstay.com/login?next=//evil.example.com
//
// The victim signs in on the genuine site with real credentials and lands on
// the attacker's page, which is then free to show a convincing "session
// expired, sign in again" form. Entering the credentials on the legitimate
// origin is exactly what sells the pivot.
//
// The callback route DID have a check — `startsWith('/') && !startsWith('//')`
// — and it admits a backslash form that every browser resolves off-origin,
// because WHATWG normalises `\` to `/` in a special scheme:
//
//     new URL('/\\evil.example.com', 'https://app.fieldstay.com').origin
//       === 'https://evil.example.com'
//
// That is why the shared helper parses instead of string-matching: it uses the
// same parser the browser will, so it cannot disagree with the browser about
// what a string means.
// ============================================================================

const FALLBACK = '/ops'

describe('safeNextPath', () => {
  it.each([
    ['a plain path',        '/ops'],
    ['a nested path',       '/settings/team'],
    ['a path with a query', '/maintenance?status=pending'],
    ['a path with a hash',  '/help#billing'],
  ])('allows %s', (_label, value) => {
    expect(safeNextPath(value, FALLBACK)).toBe(value)
  })

  // Every one of these resolves to a different origin in a browser. The first
  // two the old string check caught; the third it did NOT, and the two client
  // forms caught none of them.
  it.each([
    ['protocol-relative',      '//evil.example.com'],
    ['absolute https',         'https://evil.example.com'],
    ['absolute http',          'http://evil.example.com'],
    ['backslash-smuggled',     '/\\evil.example.com'],
    ['backslash double',       '/\\\\evil.example.com'],
    ['scheme-relative w/path', '//evil.example.com/login'],
    ['javascript scheme',      'javascript:alert(1)'],
    ['data scheme',            'data:text/html,<script>alert(1)</script>'],
    ['bare host',              'evil.example.com'],
  ])('rejects %s', (_label, value) => {
    expect(safeNextPath(value, FALLBACK)).toBe(FALLBACK)
  })

  // Pinned against the parser, not asserted from memory — if this ever stops
  // being true the rejection above is testing nothing.
  it('the backslash form really does change origin (why a string check is not enough)', () => {
    const parsed = new URL('/\\evil.example.com', 'https://app.fieldstay.com')
    expect(parsed.origin).toBe('https://evil.example.com')
    // ...and the old check would have waved it through.
    const oldCheck = (p: string) => p.startsWith('/') && !p.startsWith('//')
    expect(oldCheck('/\\evil.example.com')).toBe(true)
  })

  it.each([
    ['null',      null],
    ['undefined', undefined],
    ['empty',     ''],
  ])('falls back on %s', (_label, value) => {
    expect(safeNextPath(value, FALLBACK)).toBe(FALLBACK)
  })

  // The sentinel origin is an implementation detail; a caller must not be able
  // to reach it by supplying it directly.
  it('cannot be tricked by naming the sentinel origin', () => {
    expect(safeNextPath('https://fieldstay.invalid/ops', FALLBACK)).toBe(FALLBACK)
    expect(safeNextPath('//fieldstay.invalid/ops', FALLBACK)).toBe(FALLBACK)
  })

  it('normalises traversal rather than passing it through raw', () => {
    // Still same-origin, so allowed — but returned in resolved form.
    expect(safeNextPath('/a/../ops', FALLBACK)).toBe('/ops')
  })

  it('honours the caller-supplied fallback', () => {
    expect(safeNextPath('//evil.example.com', '/onboarding')).toBe('/onboarding')
  })
})
