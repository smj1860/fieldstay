import 'server-only'

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * SSRF guard for every outbound fetch whose URL is (even partly) attacker- or
 * tenant-controlled — iCal feed URLs, webhook targets, image URLs, etc.
 *
 * The previous per-call-site guards string-matched `url.hostname` against a
 * handful of literals (`127.0.0.1`, `10.`, `169.254.`) and then handed the URL
 * to `fetch()`, which follows redirects by default. That is defeated by, at
 * minimum:
 *
 *   • a redirect — `https://attacker.example` passes the hostname check, then
 *     302s to `http://169.254.169.254/latest/meta-data/`
 *   • DNS — `internal.attacker.example` is a public-looking name with an A
 *     record of `10.0.0.5`
 *   • IPv6 — `[::1]`, `[::ffff:127.0.0.1]`, `[fd00::1]`
 *   • alternate IPv4 encodings — `http://2130706433`, `http://0177.0.0.1`,
 *     `http://0x7f.1`
 *   • the rest of loopback — `127.1`, `127.0.0.53`
 *
 * This module closes all of those: scheme allowlist, literal-IP normalization
 * across every encoding, DNS resolution of the hostname with every returned
 * address checked, full private/loopback/link-local/reserved ranges for v4 and
 * v6, and — in `safeFetch` — manual redirect handling that re-validates every
 * hop under a bounded hop count and a hard overall timeout.
 *
 * Known residual risk: DNS rebinding. We resolve the hostname, validate the
 * answers, then let the platform `fetch` resolve it again when it connects, so
 * a TTL-0 record could flip between the two. Eliminating that requires dialing
 * the validated IP directly with a `Host` header override, which the platform
 * fetch does not expose. The hop-by-hop revalidation here removes the far more
 * practical redirect vector; rebinding is documented rather than silently
 * assumed away.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

export interface UrlGuardOptions {
  /** Allowed URL schemes, including the trailing colon. Default: HTTPS only. */
  protocols?: string[]
}

const DEFAULT_PROTOCOLS = ['https:']

/** Max redirect hops safeFetch will follow before giving up. */
const MAX_REDIRECTS = 3
/** Hard wall-clock budget for a safeFetch call, across all hops. */
const TOTAL_TIMEOUT_MS = 15_000

// ── IPv4 ────────────────────────────────────────────────────────────────────

/**
 * Parse every IPv4 spelling a resolver/`fetch` would accept, not just
 * dotted-quad: 1–4 parts, each decimal, octal (leading `0`) or hex (`0x`),
 * with the final part absorbing all remaining low-order bytes.
 * Returns the address as an unsigned 32-bit number, or null if it is not an
 * IPv4 literal in any encoding.
 */
export function parseIPv4Loose(host: string): number | null {
  const parts = host.split('.')
  if (parts.length === 0 || parts.length > 4) return null

  const values: number[] = []
  for (const part of parts) {
    if (part.length === 0) return null
    let value: number
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      value = Number.parseInt(part.slice(2), 16)
    } else if (/^0[0-7]+$/.test(part)) {
      value = Number.parseInt(part.slice(1), 8)
    } else if (/^(0|[1-9][0-9]*)$/.test(part)) {
      value = Number.parseInt(part, 10)
    } else {
      return null
    }
    if (!Number.isFinite(value) || value < 0) return null
    values.push(value)
  }

  const last = values[values.length - 1]!
  const leading = values.slice(0, -1)
  // Every leading part is a single byte; the final part absorbs the rest.
  if (leading.some((v) => v > 0xff)) return null
  const maxLast = 2 ** (8 * (4 - leading.length))
  if (last >= maxLast) return null

  let result = 0
  for (const v of leading) result = (result << 8) | v
  result = result * maxLast + last
  return result >>> 0
}

function inV4Cidr(addr: number, base: string, prefix: number): boolean {
  const baseNum = parseIPv4Loose(base)
  if (baseNum === null) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return ((addr & mask) >>> 0) === ((baseNum & mask) >>> 0)
}

/** RFC1918 + loopback + link-local + CGNAT + every other non-routable block. */
export function isBlockedIPv4(addr: number): boolean {
  const blocked: Array<[string, number]> = [
    ['0.0.0.0', 8],          // "this network"
    ['10.0.0.0', 8],         // RFC1918
    ['100.64.0.0', 10],      // CGNAT
    ['127.0.0.0', 8],        // loopback — all of it, not just 127.0.0.1
    ['169.254.0.0', 16],     // link-local, incl. cloud metadata 169.254.169.254
    ['172.16.0.0', 12],      // RFC1918
    ['192.0.0.0', 24],       // IETF protocol assignments
    ['192.0.2.0', 24],       // TEST-NET-1
    ['192.88.99.0', 24],     // 6to4 relay anycast
    ['192.168.0.0', 16],     // RFC1918
    ['198.18.0.0', 15],      // benchmarking
    ['198.51.100.0', 24],    // TEST-NET-2
    ['203.0.113.0', 24],     // TEST-NET-3
    ['224.0.0.0', 4],        // multicast
    ['240.0.0.0', 4],        // reserved, incl. 255.255.255.255 broadcast
  ]
  return blocked.some(([base, prefix]) => inV4Cidr(addr, base, prefix))
}

// ── IPv6 ────────────────────────────────────────────────────────────────────

/** Expand a valid IPv6 literal to its 8 16-bit groups. */
export function expandIPv6(host: string): number[] | null {
  if (isIP(host) !== 6) return null

  const [headText = '', tailText] = host.split('::') as [string, string?]

  // A trailing IPv4 form (::ffff:127.0.0.1, 64:ff9b::203.0.113.1) becomes two groups.
  const embedV4 = (segments: string[]): number[] | null => {
    const groups: number[] = []
    for (const seg of segments) {
      if (seg.includes('.')) {
        const v4 = parseIPv4Loose(seg)
        if (v4 === null) return null
        groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff)
      } else {
        groups.push(Number.parseInt(seg, 16))
      }
    }
    return groups
  }

  const head = embedV4(headText ? headText.split(':') : [])
  const tail = embedV4(tailText ? tailText.split(':') : [])
  if (!head || !tail) return null

  if (tailText === undefined) return head.length === 8 ? head : null

  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  return [...head, ...Array<number>(fill).fill(0), ...tail]
}

/** Loopback, unspecified, ULA, link-local, multicast, and embedded-v4 forms. */
export function isBlockedIPv6(groups: number[]): boolean {
  const isZeroPrefix = groups.slice(0, 7).every((g) => g === 0)
  if (isZeroPrefix && (groups[7] === 0 || groups[7] === 1)) return true            // :: and ::1

  const first = groups[0]!
  if ((first & 0xfe00) === 0xfc00) return true                                     // fc00::/7 (incl. fd00::/8)
  if ((first & 0xffc0) === 0xfe80) return true                                     // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true                                     // ff00::/8 multicast

  // ::ffff:a.b.c.d (v4-mapped) and ::a.b.c.d (deprecated v4-compatible)
  const mappedPrefix = groups.slice(0, 5).every((g) => g === 0)
  if (mappedPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
    return isBlockedIPv4((((groups[6]! << 16) | groups[7]!) >>> 0))
  }
  // 64:ff9b::/96 NAT64 and 2002::/16 6to4 both tunnel a v4 address.
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    return isBlockedIPv4((((groups[6]! << 16) | groups[7]!) >>> 0))
  }
  if (groups[0] === 0x2002) {
    return isBlockedIPv4((((groups[1]! << 16) | groups[2]!) >>> 0))
  }
  return false
}

// ── Address assertion ───────────────────────────────────────────────────────

/** Throws if `address` (an IP literal from DNS or the URL itself) is not publicly routable. */
export function assertPublicAddress(address: string, context: string): void {
  const version = isIP(address)
  if (version === 6) {
    const groups = expandIPv6(address)
    if (!groups) throw new UnsafeUrlError(`Unparseable IPv6 address (${context})`)
    if (isBlockedIPv6(groups)) {
      throw new UnsafeUrlError(`Blocked private/loopback IPv6 address (${context})`)
    }
    return
  }
  const v4 = parseIPv4Loose(address)
  if (v4 === null) throw new UnsafeUrlError(`Unparseable IP address (${context})`)
  if (isBlockedIPv4(v4)) {
    throw new UnsafeUrlError(`Blocked private/loopback IPv4 address (${context})`)
  }
}

/**
 * Validate a single URL: scheme, literal-IP encodings, and every address the
 * hostname resolves to. Returns the parsed URL so callers can use the
 * normalized form. Throws `UnsafeUrlError` on anything unsafe.
 */
export async function assertSafeExternalUrl(
  rawUrl: string,
  opts: UrlGuardOptions = {}
): Promise<URL> {
  const protocols = opts.protocols ?? DEFAULT_PROTOCOLS

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new UnsafeUrlError('Invalid URL format')
  }

  if (!protocols.includes(parsed.protocol)) {
    throw new UnsafeUrlError(`URL scheme ${parsed.protocol} not permitted (allowed: ${protocols.join(', ')})`)
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError('URL credentials not permitted')
  }

  // `new URL` keeps IPv6 literals bracketed; strip for IP handling.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname) throw new UnsafeUrlError('URL has no host')

  // A literal address in ANY encoding is checked directly — never handed to a
  // resolver, which is where `http://2130706433` would otherwise sneak through.
  if (isIP(hostname) !== 0 || parseIPv4Loose(hostname) !== null) {
    assertPublicAddress(hostname, `host ${hostname}`)
    return parsed
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    throw new UnsafeUrlError(`Blocked internal hostname ${hostname}`)
  }

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new UnsafeUrlError(`Could not resolve host ${hostname}`)
  }
  if (!addresses.length) throw new UnsafeUrlError(`Host ${hostname} resolved to no addresses`)

  // EVERY answer must be public — a name with one public and one private A
  // record is an attack, not a fallback.
  for (const { address } of addresses) {
    assertPublicAddress(address, `host ${hostname} → ${address}`)
  }

  return parsed
}

/**
 * Drop-in replacement for `fetch()` on any attacker-influenced URL.
 *
 * Every hop is validated before it is issued (`redirect: 'manual'` — the
 * platform default of `'follow'` is exactly what made the original guard
 * bypassable), hops are capped, and the whole call is bounded by one wall-clock
 * deadline rather than a per-request timeout a redirect chain could multiply.
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS
  let currentUrl = rawUrl

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // HTTPS on every hop, including redirect targets — a redirect to plaintext
    // is a downgrade, not a legitimate provider behavior.
    const url = await assertSafeExternalUrl(currentUrl)

    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new UnsafeUrlError('Timed out validating/fetching URL')

    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal:   init.signal ?? AbortSignal.timeout(remaining),
    })

    if (response.status < 300 || response.status >= 400) return response

    const location = response.headers.get('location')
    if (!location) return response

    // Resolve relative Location headers against the hop we just made.
    currentUrl = new URL(location, url).toString()
  }

  throw new UnsafeUrlError(`Too many redirects (>${MAX_REDIRECTS})`)
}
