import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ok,
  fail,
  timingSafeEqual,
  isTimestampFresh,
  extractClientIp,
  isIpInCidr,
} from '@/lib/integrations/webhook-verification'

describe('ok / fail', () => {
  it('ok() returns a valid result with no reason', () => {
    expect(ok()).toEqual({ valid: true })
  })

  it('fail() returns an invalid result carrying the given reason', () => {
    expect(fail('bad signature')).toEqual({ valid: false, reason: 'bad signature' })
  })
})

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
  })

  it('returns false for strings that differ in content but not length', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false)
  })

  it('returns false for strings of different length', () => {
    expect(timingSafeEqual('short', 'a-much-longer-string')).toBe(false)
  })

  it('returns true for two empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true)
  })
})

describe('isTimestampFresh', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('treats the current instant as fresh', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const nowSeconds = Date.now() / 1000
    expect(isTimestampFresh(nowSeconds)).toBe(true)
  })

  it('treats a timestamp 299s old as fresh (just inside the default 300s window)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const nowSeconds = Date.now() / 1000
    expect(isTimestampFresh(nowSeconds - 299)).toBe(true)
  })

  it('treats a timestamp exactly 300s old as fresh (inclusive boundary)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const nowSeconds = Date.now() / 1000
    expect(isTimestampFresh(nowSeconds - 300)).toBe(true)
  })

  it('treats a timestamp 301s old as stale (just outside the default 300s window)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const nowSeconds = Date.now() / 1000
    expect(isTimestampFresh(nowSeconds - 301)).toBe(false)
  })

  it('treats a timestamp 299s in the future as fresh (negative skew is symmetric)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const nowSeconds = Date.now() / 1000
    expect(isTimestampFresh(nowSeconds + 299)).toBe(true)
  })

  it('treats a timestamp 301s in the future as stale (future skew rejected too)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const nowSeconds = Date.now() / 1000
    expect(isTimestampFresh(nowSeconds + 301)).toBe(false)
  })

  it('respects a custom tolerance window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const nowSeconds = Date.now() / 1000
    expect(isTimestampFresh(nowSeconds - 30, 60)).toBe(true)
    expect(isTimestampFresh(nowSeconds - 90, 60)).toBe(false)
  })

  it('treats a zero tolerance as fresh only for the exact current instant', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const nowSeconds = Date.now() / 1000
    expect(isTimestampFresh(nowSeconds, 0)).toBe(true)
    expect(isTimestampFresh(nowSeconds - 1, 0)).toBe(false)
  })
})

describe('extractClientIp', () => {
  // Trust order exists because EVERY per-IP limiter in the app keys on this
  // one function. The previous implementation took the leftmost
  // x-forwarded-for entry, which a client controls under a standard
  // append-style proxy — one header would have given each request its own
  // rate-limit bucket across nine limiters simultaneously.
  it('prefers x-vercel-forwarded-for over anything the client can set', () => {
    const request = new Request('https://example.com', {
      headers: {
        'x-vercel-forwarded-for': '203.0.113.9',
        'x-real-ip':              '198.51.100.7',
        'x-forwarded-for':        '1.2.3.4, 203.0.113.9',
      },
    })
    expect(extractClientIp(request)).toBe('203.0.113.9')
  })

  it('falls back to x-real-ip when the Vercel header is absent', () => {
    const request = new Request('https://example.com', {
      headers: {
        'x-real-ip':       '198.51.100.7',
        'x-forwarded-for': '1.2.3.4, 198.51.100.7',
      },
    })
    expect(extractClientIp(request)).toBe('198.51.100.7')
  })

  // The spoof this fix exists to defeat: a caller prepends a fake entry and
  // the proxy appends the real address after it. Reading the left-hand end
  // returns the attacker's value; the right-hand end returns the proxy's.
  it('does NOT return a client-prepended x-forwarded-for entry', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 203.0.113.9' },
    })
    const ip = extractClientIp(request)
    expect(ip).not.toBe('1.2.3.4')
    expect(ip).toBe('203.0.113.9')
  })

  it('trims whitespace around the selected entry', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '  1.2.3.4  ,  203.0.113.9  ' },
    })
    expect(extractClientIp(request)).toBe('203.0.113.9')
  })

  it('returns the single IP when there is only one', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '38.80.170.5' },
    })
    expect(extractClientIp(request)).toBe('38.80.170.5')
  })

  it('ignores empty entries rather than returning an empty string', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '203.0.113.9, ,' },
    })
    expect(extractClientIp(request)).toBe('203.0.113.9')
  })

  it('returns null when the header is absent', () => {
    const request = new Request('https://example.com')
    expect(extractClientIp(request)).toBeNull()
  })

  it('returns null when the header is present but empty', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '' },
    })
    expect(extractClientIp(request)).toBeNull()
  })
})

describe('isIpInCidr', () => {
  it('returns true for an IP within a /24 range', () => {
    expect(isIpInCidr('38.80.170.5', '38.80.170.0/24')).toBe(true)
  })

  it('returns false for an IP outside a /24 range', () => {
    expect(isIpInCidr('38.80.171.5', '38.80.170.0/24')).toBe(false)
  })

  it('returns true for an exact /32 match', () => {
    expect(isIpInCidr('38.80.170.5', '38.80.170.5/32')).toBe(true)
  })

  it('returns false for a /32 non-match', () => {
    expect(isIpInCidr('38.80.170.6', '38.80.170.5/32')).toBe(false)
  })

  it('returns true for any IP under a /0 range', () => {
    expect(isIpInCidr('1.2.3.4', '0.0.0.0/0')).toBe(true)
  })

  it('handles a range boundary correctly at the top of a /24 block', () => {
    expect(isIpInCidr('38.80.170.255', '38.80.170.0/24')).toBe(true)
    expect(isIpInCidr('38.80.171.0', '38.80.170.0/24')).toBe(false)
  })

  it('returns false for a malformed IP address', () => {
    expect(isIpInCidr('not-an-ip', '38.80.170.0/24')).toBe(false)
  })

  it('returns false for an IP octet out of range', () => {
    expect(isIpInCidr('38.80.170.999', '38.80.170.0/24')).toBe(false)
  })

  it('returns false for a malformed CIDR range', () => {
    expect(isIpInCidr('38.80.170.5', 'not-a-cidr/24')).toBe(false)
  })

  it('returns false for an out-of-range prefix length', () => {
    expect(isIpInCidr('38.80.170.5', '38.80.170.0/33')).toBe(false)
  })

  it('returns false for a negative prefix length', () => {
    expect(isIpInCidr('38.80.170.5', '38.80.170.0/-1')).toBe(false)
  })
})
