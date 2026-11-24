import { describe, it, expect, vi, beforeEach } from 'vitest'

const safeFetch = vi.hoisted(() => vi.fn())
const UnsafeUrlError = vi.hoisted(() => class UnsafeUrlError extends Error {})
vi.mock('@/lib/security/url-guard', () => ({ safeFetch, UnsafeUrlError }))

import { MAX_PAGES, researchSite, isPermanentSiteError, LEAD_GEN_USER_AGENT } from '@/lib/gtm/teams/lead-gen-fetch'

// ============================================================================
// The polite-crawler promises, asserted: identify ourselves, obey robots.txt,
// read at most three pages, never leave the site, and tell "the site was
// struggling" (retry later) apart from "the site has nothing" (a real answer).
// ============================================================================

function respond(routes: Record<string, { status?: number; body?: string; type?: string }>) {
  const seen: string[] = []
  safeFetch.mockImplementation(async (url: string) => {
    seen.push(url)
    const r = routes[url] ?? { status: 404 }
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'text/html' } })
  })
  return seen
}

const HOME = 'https://acmerentals.com/'
const ORIGIN = 'https://acmerentals.com'

beforeEach(() => {
  safeFetch.mockReset()
  // The 600ms courtesy pause is real in production and pointless in a test.
  vi.stubGlobal('setTimeout', (fn: () => void) => { fn(); return 0 })
})

describe('researchSite', () => {
  it('reads robots.txt first, identifying itself, and then the homepage', async () => {
    const seen = respond({ [`${ORIGIN}/robots.txt`]: { body: '', type: 'text/plain' }, [HOME]: { body: '<p>hi</p>' } })
    await researchSite(HOME)
    expect(seen[0]).toBe(`${ORIGIN}/robots.txt`)
    expect(seen[1]).toBe(HOME)
    expect(safeFetch.mock.calls[0][1].headers['User-Agent']).toBe(LEAD_GEN_USER_AGENT)
    expect(safeFetch.mock.calls[1][1].headers['User-Agent']).toBe(LEAD_GEN_USER_AGENT)
  })

  it('every request carries a timeout', async () => {
    respond({ [HOME]: { body: 'x' } })
    await researchSite(HOME)
    for (const call of safeFetch.mock.calls) expect(call[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('reads nothing at all when robots.txt disallows the site', async () => {
    const seen = respond({ [`${ORIGIN}/robots.txt`]: { body: 'User-agent: *\nDisallow: /', type: 'text/plain' }, [HOME]: { body: 'secret' } })
    expect(await researchSite(HOME)).toEqual({ pages: [], robotsBlocked: true })
    expect(seen).toEqual([`${ORIGIN}/robots.txt`])
  })

  it('skips a page that robots.txt disallows but still reads the ones it allows', async () => {
    const seen = respond({
      [`${ORIGIN}/robots.txt`]: { body: 'User-agent: *\nDisallow: /contact', type: 'text/plain' },
      [HOME]: { body: '<a href="/contact">Contact</a>' },
    })
    const r = await researchSite(HOME)
    expect(r.pages.map((p) => p.url)).toEqual([HOME])
    expect(seen).not.toContain(`${ORIGIN}/contact`)
  })

  it('follows the homepage\'s own contact link, and extracts from every page it read', async () => {
    respond({
      [HOME]: { body: '<a href="/get-in-touch-contact">Contact</a>' },
      [`${ORIGIN}/get-in-touch-contact`]: { body: '<a href="mailto:dana@acmerentals.com">x</a><a href="tel:8655550142">y</a>' },
    })
    const r = await researchSite(HOME)
    expect(r.pages).toHaveLength(2)
    expect(r.pages[1].findings.emails[0].email).toBe('dana@acmerentals.com')
    expect(r.pages[1].findings.phones[0].e164).toBe('+18655550142')
  })

  it('falls back to the usual contact paths when the homepage links none', async () => {
    const seen = respond({ [HOME]: { body: 'plain' }, [`${ORIGIN}/contact`]: { body: 'x' } })
    await researchSite(HOME)
    expect(seen).toContain(`${ORIGIN}/contact`)
  })

  it('reads at most three pages, however many contact links there are', async () => {
    const links = Array.from({ length: 10 }, (_, i) => `<a href="/contact-${i}">c</a>`).join('')
    const routes: Record<string, { body: string }> = { [HOME]: { body: links } }
    for (let i = 0; i < 10; i++) routes[`${ORIGIN}/contact-${i}`] = { body: 'x' }
    const seen = respond(routes)
    const r = await researchSite(HOME)
    expect(r.pages.length).toBeLessThanOrEqual(MAX_PAGES)
    expect(seen.filter((u) => u !== `${ORIGIN}/robots.txt`).length).toBeLessThanOrEqual(MAX_PAGES)
  })

  it('never follows a contact link to another site', async () => {
    const seen = respond({ [HOME]: { body: '<a href="https://evil.example.org/contact">c</a>' } })
    await researchSite(HOME)
    expect(seen.some((u) => u.includes('evil.example.org'))).toBe(false)
  })

  it('skips a page that is not HTML', async () => {
    respond({ [HOME]: { body: '%PDF-', type: 'application/pdf' } })
    expect((await researchSite(HOME)).pages).toEqual([])
  })

  it('treats a missing robots.txt as permission', async () => {
    respond({ [`${ORIGIN}/robots.txt`]: { status: 404 }, [HOME]: { body: 'x' } })
    expect((await researchSite(HOME)).pages).toHaveLength(1)
  })

  // A struggling site has not said yes, and has not said it has no contact details.
  it('throws, so the task retries, when robots.txt itself returns a server error', async () => {
    respond({ [`${ORIGIN}/robots.txt`]: { status: 503 } })
    await expect(researchSite(HOME)).rejects.toThrow('robots.txt unavailable')
  })

  it('throws, so the task retries, when every page returns a server error or rate limit', async () => {
    respond({ [HOME]: { status: 503 }, [`${ORIGIN}/contact`]: { status: 429 }, [`${ORIGIN}/contact-us`]: { status: 503 } })
    await expect(researchSite(HOME)).rejects.toThrow('Site unavailable')
  })

  it('returns an honest empty result, not an error, when the pages simply do not exist', async () => {
    respond({ [HOME]: { status: 404 } })
    expect(await researchSite(HOME)).toEqual({ pages: [], robotsBlocked: false })
  })

  it('keeps what it found when only some pages are struggling', async () => {
    respond({ [HOME]: { body: '<a href="mailto:a@acmerentals.com">x</a>' }, [`${ORIGIN}/contact`]: { status: 503 } })
    expect((await researchSite(HOME)).pages).toHaveLength(1)
  })

  it('propagates a network failure from the safe fetcher so the task is retried', async () => {
    safeFetch.mockRejectedValue(new Error('Refusing private address'))
    await expect(researchSite(HOME)).rejects.toThrow('private address')
  })
})

// A stranger's broken site is an answer, not a fault: Sentry 1P was a prospect
// whose HTTPS certificate had expired, retried and reported on every attempt.
describe('permanently broken sites', () => {
  function fetchFailed(code: string): TypeError {
    return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) })
  }

  it('closes as nothing found when the certificate has expired', async () => {
    safeFetch.mockRejectedValue(fetchFailed('CERT_HAS_EXPIRED'))
    expect(await researchSite(HOME)).toEqual({ pages: [], robotsBlocked: false })
  })

  it('closes as nothing found when the domain no longer resolves', async () => {
    safeFetch.mockRejectedValue(new UnsafeUrlError('Could not resolve host acmerentals.com'))
    expect(await researchSite(HOME)).toEqual({ pages: [], robotsBlocked: false })
  })

  it('still throws on a timeout so the task retries', async () => {
    safeFetch.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    await expect(researchSite(HOME)).rejects.toThrow()
    safeFetch.mockRejectedValue(new UnsafeUrlError('Timed out validating/fetching URL'))
    await expect(researchSite(HOME)).rejects.toThrow()
  })

  it('classifies only known permanent causes', () => {
    expect(isPermanentSiteError(fetchFailed('ECONNREFUSED'))).toBe(true)
    expect(isPermanentSiteError(fetchFailed('ECONNRESET'))).toBe(false)
    expect(isPermanentSiteError('nope')).toBe(false)
  })
})
