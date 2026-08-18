import { describe, it, expect, beforeEach, afterEach } from 'vitest'

// ============================================================================
// validateBasicAuthWebhook — the auth gate for every provider whose webhooks
// carry credentials WE chose at registration (OwnerRez and Hostaway).
//
// Extracted from ownerrez.ts when Hostaway needed the identical check. Both
// providers now depend on these ~30 lines, so a regression here opens two
// webhook endpoints at once — which is the reason it is tested directly rather
// than only through each provider.
//
// Two of the cases below are corrections that each took a real bug to find, and
// both are the kind that PASS a naive test: a truncated password still
// compares equal against its own prefix, and a timing leak is invisible to any
// assertion about the return value.
// ============================================================================

import { validateBasicAuthWebhook, parseCidrAllowlist } from '@/lib/integrations/webhook-verification'

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://fieldstay.app/api/webhooks/hostaway', { method: 'POST', headers })
}

const CREDS = { expectedUser: 'hookuser', expectedPass: 'hookpass', envPrefix: 'HOSTAWAY_WEBHOOK' }

describe('validateBasicAuthWebhook', () => {
  it('accepts a matching credential pair', () => {
    const result = validateBasicAuthWebhook({
      request: request({ Authorization: basic('hookuser', 'hookpass') }),
      ...CREDS, allowedCidrs: [],
    })
    expect(result.valid).toBe(true)
  })

  it('rejects a wrong password', () => {
    const result = validateBasicAuthWebhook({
      request: request({ Authorization: basic('hookuser', 'nope') }),
      ...CREDS, allowedCidrs: [],
    })
    expect(result.valid).toBe(false)
  })

  it('rejects a wrong username even when the password matches', () => {
    const result = validateBasicAuthWebhook({
      request: request({ Authorization: basic('someoneelse', 'hookpass') }),
      ...CREDS, allowedCidrs: [],
    })
    expect(result.valid).toBe(false)
  })

  it('rejects a missing or non-Basic Authorization header', () => {
    expect(validateBasicAuthWebhook({ request: request(), ...CREDS, allowedCidrs: [] }).valid).toBe(false)
    expect(validateBasicAuthWebhook({
      request: request({ Authorization: 'Bearer sometoken' }), ...CREDS, allowedCidrs: [],
    }).valid).toBe(false)
  })

  // THE COLON RULE. `decoded.split(':', 2)` splits on EVERY colon then truncates
  // to two entries, so this password would arrive as 'pass' and compare equal
  // against a prefix of itself — an attacker knowing only the part before the
  // first colon would authenticate. RFC 7617 makes only the FIRST colon a
  // delimiter.
  it('treats only the FIRST colon as the delimiter, so a password may contain colons', () => {
    const pass = 'pass:with:colons'
    const result = validateBasicAuthWebhook({
      request:      request({ Authorization: basic('hookuser', pass) }),
      expectedUser: 'hookuser',
      expectedPass: pass,
      envPrefix:    'HOSTAWAY_WEBHOOK',
      allowedCidrs: [],
    })
    expect(result.valid).toBe(true)
  })

  it('does NOT accept the truncated prefix of a colon-containing password', () => {
    // The other half of the rule: the bug's payload must be refused.
    const result = validateBasicAuthWebhook({
      request:      request({ Authorization: basic('hookuser', 'pass') }),
      expectedUser: 'hookuser',
      expectedPass: 'pass:with:colons',
      envPrefix:    'HOSTAWAY_WEBHOOK',
      allowedCidrs: [],
    })
    expect(result.valid).toBe(false)
  })

  it('THROWS rather than rejecting when the expected credentials are unset', () => {
    // An operator misconfiguration, not a bad delivery. Returning "unauthorized"
    // here would make a correctly-signed provider look like an attacker while
    // the real problem is a missing env var.
    expect(() => validateBasicAuthWebhook({
      request: request({ Authorization: basic('hookuser', 'hookpass') }),
      expectedUser: undefined, expectedPass: undefined,
      envPrefix: 'HOSTAWAY_WEBHOOK', allowedCidrs: [],
    })).toThrow(/HOSTAWAY_WEBHOOK_USER/)
  })

  describe('source-IP allowlist', () => {
    it('rejects an out-of-range source IP before checking credentials', () => {
      const result = validateBasicAuthWebhook({
        request: request({ Authorization: basic('hookuser', 'hookpass'), 'x-forwarded-for': '9.9.9.9' }),
        ...CREDS, allowedCidrs: ['38.80.170.0/24'],
      })
      expect(result.valid).toBe(false)
      expect(result.reason).toMatch(/IP_CIDRS/)
    })

    it('accepts an in-range source IP with valid credentials', () => {
      const result = validateBasicAuthWebhook({
        request: request({ Authorization: basic('hookuser', 'hookpass'), 'x-forwarded-for': '38.80.170.5' }),
        ...CREDS, allowedCidrs: ['38.80.170.0/24'],
      })
      expect(result.valid).toBe(true)
    })

    it('an EMPTY allowlist means no IP restriction, not "reject everything"', () => {
      // The default, and the direction that matters: a typo'd env var name
      // yields an empty list, and reading that as "allow nothing" would drop
      // every delivery silently until someone noticed bookings had stopped.
      const result = validateBasicAuthWebhook({
        request: request({ Authorization: basic('hookuser', 'hookpass'), 'x-forwarded-for': '9.9.9.9' }),
        ...CREDS, allowedCidrs: [],
      })
      expect(result.valid).toBe(true)
    })
  })
})

describe('parseCidrAllowlist', () => {
  it('parses a comma-separated list, trimming and dropping blanks', () => {
    expect(parseCidrAllowlist(' 1.2.3.0/24 , 5.6.7.8/32 ,, ')).toEqual(['1.2.3.0/24', '5.6.7.8/32'])
  })

  it('returns an empty list for unset or blank, which means "no restriction"', () => {
    expect(parseCidrAllowlist(undefined)).toEqual([])
    expect(parseCidrAllowlist('')).toEqual([])
    expect(parseCidrAllowlist('   ')).toEqual([])
  })
})

describe('provider wiring', () => {
  const ENV = process.env

  beforeEach(() => { process.env = { ...ENV } })
  afterEach(()  => { process.env = ENV })

  it('hostawayProvider.validateWebhook accepts its own configured pair', async () => {
    process.env.HOSTAWAY_WEBHOOK_USER     = 'hw_user'
    process.env.HOSTAWAY_WEBHOOK_PASSWORD = 'hw_pass'
    delete process.env.HOSTAWAY_WEBHOOK_IP_CIDRS

    const { hostawayProvider } = await import('@/lib/integrations/providers/hostaway')
    const result = await hostawayProvider.validateWebhook!(
      request({ Authorization: basic('hw_user', 'hw_pass') }),
    )
    expect(result.valid).toBe(true)
  })

  it('hostawayProvider.validateWebhook rejects the OwnerRez pair', async () => {
    // The two providers must not share a credential — a delivery authenticated
    // for one must not be accepted by the other's endpoint.
    process.env.HOSTAWAY_WEBHOOK_USER     = 'hw_user'
    process.env.HOSTAWAY_WEBHOOK_PASSWORD = 'hw_pass'
    process.env.OWNERREZ_WEBHOOK_USER     = 'or_user'
    process.env.OWNERREZ_WEBHOOK_PASSWORD = 'or_pass'

    const { hostawayProvider } = await import('@/lib/integrations/providers/hostaway')
    const result = await hostawayProvider.validateWebhook!(
      request({ Authorization: basic('or_user', 'or_pass') }),
    )
    expect(result.valid).toBe(false)
  })
})
