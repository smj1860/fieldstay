import { describe, it, expect } from 'vitest'
import {
  decodeCloudflareEmail, extractFromPage, isUsableEmail, rankEmails, rankPhones, siteDomainOf,
  type EmailCandidate, type PhoneCandidate,
} from '@/lib/gtm/teams/lead-gen-extract'

const URL1 = 'https://acmerentals.com/'
const URL2 = 'https://acmerentals.com/contact'

const email = (e: string, how: EmailCandidate['how'] = 'text', url = URL1): EmailCandidate => ({ email: e, how, sourceUrl: url })
const phone = (p: string, how: PhoneCandidate['how'] = 'text', url = URL1): PhoneCandidate => ({ e164: p, how, sourceUrl: url })

describe('extractFromPage: emails', () => {
  it('reads a mailto link, including a query string on it', () => {
    const r = extractFromPage('<a href="mailto:Dana@AcmeRentals.com?subject=Hi">Email us</a>', URL1)
    expect(r.emails).toEqual([{ email: 'dana@acmerentals.com', how: 'mailto', sourceUrl: URL1 }])
  })

  it('reads an address printed in the page text', () => {
    const r = extractFromPage('<p>Reach us at <b>info@acmerentals.com</b> any time.</p>', URL1)
    expect(r.emails.map((e) => e.email)).toEqual(['info@acmerentals.com'])
    expect(r.emails[0].how).toBe('text')
  })

  it('decodes a Cloudflare-protected address', () => {
    // "dana@acme.com" XOR-encoded with key 0x4f
    const key = 0x4f
    const hex = [key, ...[...'dana@acme.com'].map((c) => c.charCodeAt(0) ^ key)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const r = extractFromPage(`<a class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</a>`, URL1)
    expect(r.emails).toEqual([{ email: 'dana@acme.com', how: 'cloudflare', sourceUrl: URL1 }])
  })

  it('reads email and telephone out of JSON-LD structured data', () => {
    const html = `<script type="application/ld+json">{"@type":"LocalBusiness","email":"hello@acmerentals.com","telephone":"(865) 555-0142"}</script>`
    const r = extractFromPage(html, URL1)
    expect(r.emails).toEqual([{ email: 'hello@acmerentals.com', how: 'json_ld', sourceUrl: URL1 }])
    expect(r.phones).toEqual([{ e164: '+18655550142', how: 'json_ld', sourceUrl: URL1 }])
  })

  it('survives a malformed JSON-LD block and still reads the rest of the page', () => {
    const html = `<script type="application/ld+json">{not json</script><a href="mailto:a@acmerentals.com">x</a>`
    expect(extractFromPage(html, URL1).emails.map((e) => e.email)).toEqual(['a@acmerentals.com'])
  })

  it('does not read an address out of a script or style body', () => {
    const html = `<script>var support = "tracker@analytics-vendor.com"</script><style>.a{content:"x@y.com"}</style><p>None here</p>`
    expect(extractFromPage(html, URL1).emails).toEqual([])
  })

  it('ignores placeholders, platform noise and filenames that merely contain an @', () => {
    const html = `<p>you@example.com noreply@acmerentals.com banner@2x.png x@sentry.io user@domain.com</p>`
    expect(extractFromPage(html, URL1).emails).toEqual([])
  })

  it('does not report the same address twice from the same source', () => {
    const html = `<a href="mailto:a@acmerentals.com">a</a><a href="mailto:a@acmerentals.com">again</a>`
    expect(extractFromPage(html, URL1).emails).toHaveLength(1)
  })

  it('decodes HTML entities in a mailto href', () => {
    expect(extractFromPage('<a href="mailto:a&#64;acmerentals.com">x</a>', URL1).emails).toEqual([])
    expect(extractFromPage('<a href="mailto:a%40acmerentals.com">x</a>', URL1).emails[0].email).toBe('a@acmerentals.com')
  })
})

describe('extractFromPage: phones and links', () => {
  it('reads tel links and printed numbers into E.164', () => {
    const html = `<a href="tel:+1-865-555-0142">Call</a><p>Office: (865) 555-0199</p>`
    const r = extractFromPage(html, URL1)
    expect(r.phones.map((p) => `${p.e164}:${p.how}`).sort()).toEqual(['+18655550142:tel', '+18655550199:text'])
  })

  it('ignores digit runs that are not phone numbers', () => {
    expect(extractFromPage('<p>Order 123-45-6789, 2024-01-15, 12345</p>', URL1).phones).toEqual([])
  })

  it('finds same-origin contact links and nothing off-site', () => {
    const html = `<a href="/contact-us">Contact</a><a href="https://other.com/contact">x</a><a href="/about">About</a>`
    expect(extractFromPage(html, URL1).contactLinks).toEqual(['https://acmerentals.com/contact-us'])
  })

  it('does not follow a link to plain http', () => {
    expect(extractFromPage('<a href="http://acmerentals.com/contact">x</a>', URL1).contactLinks).toEqual([])
  })

  // The HTML is a stranger's. None of these may hang the worker.
  it('stays fast on pathological input', () => {
    const started = Date.now()
    extractFromPage(`<a href="${'mailto:'.repeat(5_000)}`, URL1)
    extractFromPage('a'.repeat(300_000) + '@' + 'b'.repeat(300_000), URL1)
    extractFromPage('<script>'.repeat(20_000), URL1)
    extractFromPage('<a '.repeat(20_000), URL1)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

describe('isUsableEmail / decodeCloudflareEmail', () => {
  it('accepts a normal address and rejects junk', () => {
    expect(isUsableEmail('Dana@AcmeRentals.com')).toBe('dana@acmerentals.com')
    expect(isUsableEmail('not an email')).toBeNull()
    expect(isUsableEmail('abuse@acmerentals.com')).toBeNull()
  })

  it('refuses a malformed protected string rather than decoding garbage', () => {
    expect(decodeCloudflareEmail('zz')).toBeNull()
    expect(decodeCloudflareEmail('abc')).toBeNull()
  })
})

describe('rankEmails', () => {
  const domain = 'acmerentals.com'

  it('puts an address on the company\'s own domain ahead of one on someone else\'s', () => {
    const ranked = rankEmails([email('dana@gmail.com', 'mailto'), email('info@acmerentals.com', 'text')], domain)
    expect(ranked.map((r) => r.email)).toEqual(['info@acmerentals.com', 'dana@gmail.com'])
  })

  // A widget vendor's support address in body text is the commonest false positive.
  it('drops a bare text address on a third-party domain', () => {
    expect(rankEmails([email('support@widgetvendor.com', 'text')], domain)).toEqual([])
  })

  it('keeps a deliberate mailto link even off-domain, since small operators use Gmail', () => {
    expect(rankEmails([email('dana.acmerentals@gmail.com', 'mailto')], domain)).toHaveLength(1)
  })

  it('counts a subdomain as the company\'s own domain', () => {
    expect(rankEmails([email('a@mail.acmerentals.com', 'text')], domain)).toHaveLength(1)
  })

  it('does not treat a lookalike domain as the company\'s own', () => {
    expect(rankEmails([email('a@notacmerentals.com', 'text')], domain)).toEqual([])
  })

  it('rewards an address seen on more than one page', () => {
    const ranked = rankEmails([email('a@acmerentals.com', 'text', URL1), email('a@acmerentals.com', 'text', URL2), email('b@acmerentals.com', 'text', URL1)], domain)
    expect(ranked[0].email).toBe('a@acmerentals.com')
  })

  it('breaks ties the same way every time', () => {
    const a = rankEmails([email('b@acmerentals.com'), email('a@acmerentals.com')], domain).map((r) => r.email)
    const b = rankEmails([email('a@acmerentals.com'), email('b@acmerentals.com')], domain).map((r) => r.email)
    expect(a).toEqual(['a@acmerentals.com', 'b@acmerentals.com'])
    expect(b).toEqual(a)
  })

  it('works with no known site domain', () => {
    expect(rankEmails([email('a@x.com', 'mailto')], null)).toHaveLength(1)
  })
})

describe('rankPhones / siteDomainOf', () => {
  it('prefers a tel link over printed text, then the number seen more often', () => {
    const ranked = rankPhones([phone('+18655550199', 'text'), phone('+18655550142', 'tel'), phone('+18655550199', 'text', URL2)])
    expect(ranked[0].e164).toBe('+18655550142')
  })

  it('strips www from a site\'s domain and survives a bad URL', () => {
    expect(siteDomainOf('https://www.AcmeRentals.com/x')).toBe('acmerentals.com')
    expect(siteDomainOf('not a url')).toBeNull()
  })
})
