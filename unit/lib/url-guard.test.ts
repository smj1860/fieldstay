import { describe, it, expect } from 'vitest'
import {
  parseIPv4Loose,
  isBlockedIPv4,
  expandIPv6,
  isBlockedIPv6,
  assertPublicAddress,
  assertSafeExternalUrl,
  UnsafeUrlError,
} from '@/lib/security/url-guard'

// The iCal feed guard this replaced string-matched url.hostname against five
// literals. These cases are the specific bypasses that guard allowed through —
// each one reached http://169.254.169.254/latest/meta-data/ (or an internal
// service) with the response body parsed and persisted.

describe('parseIPv4Loose — every encoding a resolver accepts', () => {
  it('parses dotted-quad', () => {
    expect(parseIPv4Loose('127.0.0.1')).toBe(0x7f000001)
    expect(parseIPv4Loose('169.254.169.254')).toBe(0xa9fea9fe)
  })

  it('parses the bare-integer form (http://2130706433)', () => {
    expect(parseIPv4Loose('2130706433')).toBe(0x7f000001)
  })

  it('parses octal and hex forms', () => {
    expect(parseIPv4Loose('0177.0.0.1')).toBe(0x7f000001)
    expect(parseIPv4Loose('0x7f.0.0.1')).toBe(0x7f000001)
    expect(parseIPv4Loose('0x7f000001')).toBe(0x7f000001)
  })

  it('parses short forms where the last part absorbs the remaining bytes', () => {
    expect(parseIPv4Loose('127.1')).toBe(0x7f000001)
    expect(parseIPv4Loose('127.0.1')).toBe(0x7f000001)
  })

  it('returns null for hostnames', () => {
    expect(parseIPv4Loose('calendar.airbnb.com')).toBeNull()
    expect(parseIPv4Loose('example')).toBeNull()
    expect(parseIPv4Loose('1.2.3.4.5')).toBeNull()
    expect(parseIPv4Loose('256.0.0.1')).toBeNull()
  })
})

describe('isBlockedIPv4 — full ranges, not just the five old literals', () => {
  const blocked = [
    '127.0.0.1', '127.0.0.53', '127.255.255.254',   // all of 127/8, not just .0.0.1
    '169.254.169.254',                              // cloud metadata
    '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1',                                   // CGNAT
    '0.0.0.0', '255.255.255.255', '224.0.0.1',
  ]
  it.each(blocked)('blocks %s', (ip) => {
    expect(isBlockedIPv4(parseIPv4Loose(ip)!)).toBe(true)
  })

  const allowed = ['8.8.8.8', '1.1.1.1', '52.94.236.248', '172.32.0.1', '172.15.255.255']
  it.each(allowed)('allows public %s', (ip) => {
    expect(isBlockedIPv4(parseIPv4Loose(ip)!)).toBe(false)
  })
})

describe('IPv6 — the entire family the old guard ignored', () => {
  it('expands compressed and v4-embedded forms', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(expandIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
    expect(expandIPv6('fd00::1')?.[0]).toBe(0xfd00)
  })

  const blocked = ['::1', '::', '::ffff:127.0.0.1', '::ffff:169.254.169.254', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1']
  it.each(blocked)('blocks %s', (ip) => {
    expect(isBlockedIPv6(expandIPv6(ip)!)).toBe(true)
  })

  it('allows a public IPv6 address', () => {
    expect(isBlockedIPv6(expandIPv6('2606:4700:4700::1111')!)).toBe(false)
  })

  it('blocks a 6to4 tunnel wrapping a private v4 address', () => {
    // 2002:0a00:0001:: encodes 10.0.0.1
    expect(isBlockedIPv6(expandIPv6('2002:a00:1::')!)).toBe(true)
  })
})

describe('assertPublicAddress', () => {
  it('throws on private addresses', () => {
    expect(() => assertPublicAddress('169.254.169.254', 'test')).toThrow(UnsafeUrlError)
    expect(() => assertPublicAddress('::1', 'test')).toThrow(UnsafeUrlError)
  })

  it('accepts public addresses', () => {
    expect(() => assertPublicAddress('8.8.8.8', 'test')).not.toThrow()
  })
})

describe('assertSafeExternalUrl', () => {
  it('rejects non-HTTPS schemes by default', async () => {
    await expect(assertSafeExternalUrl('http://example.com/feed.ics')).rejects.toThrow(UnsafeUrlError)
    await expect(assertSafeExternalUrl('file:///etc/passwd')).rejects.toThrow(UnsafeUrlError)
    await expect(assertSafeExternalUrl('gopher://example.com')).rejects.toThrow(UnsafeUrlError)
  })

  it('rejects literal private/loopback hosts in every encoding — no DNS needed', async () => {
    const hosts = [
      'https://127.0.0.1/x',
      'https://127.0.0.53/x',
      'https://2130706433/x',
      'https://0177.0.0.1/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://[fd00::1]/x',
      'https://10.0.0.5/x',
    ]
    for (const url of hosts) {
      await expect(assertSafeExternalUrl(url), url).rejects.toThrow(UnsafeUrlError)
    }
  })

  it('rejects internal hostnames without resolving them', async () => {
    await expect(assertSafeExternalUrl('https://localhost/x')).rejects.toThrow(UnsafeUrlError)
    await expect(assertSafeExternalUrl('https://metadata.internal/x')).rejects.toThrow(UnsafeUrlError)
    await expect(assertSafeExternalUrl('https://printer.local/x')).rejects.toThrow(UnsafeUrlError)
  })

  it('rejects embedded credentials and malformed URLs', async () => {
    await expect(assertSafeExternalUrl('https://user:pass@example.com/x')).rejects.toThrow(UnsafeUrlError)
    await expect(assertSafeExternalUrl('not a url')).rejects.toThrow(UnsafeUrlError)
  })

  it('honours an explicit protocol allowlist', async () => {
    await expect(
      assertSafeExternalUrl('http://127.0.0.1/x', { protocols: ['http:'] })
    ).rejects.toThrow(/private\/loopback/)
  })
})
