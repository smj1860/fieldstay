import { describe, it, expect } from 'vitest'
import { extractProfile, isComparentUrlAllowed } from '@/lib/prospecting/comparent-extract'

const URL = 'https://comparent.com/str/tn/gatlinburg/smoky-mountain-escapes'

function page(body: string): string {
  return `<html><head><title>Smoky Mountain Escapes in Gatlinburg, TN - Comparent</title></head><body>${body}</body></html>`
}

describe('extractProfile', () => {
  // The bug this pins: the stat strip renders as one run-on string
  // ("… Full Time Employees 14 Total managed properties 95"). Reading a
  // number off a pattern that isn't anchored on ITS OWN label grabs the
  // wrong one — this test's fixture puts a smaller number right before the
  // real total specifically to catch that regression.
  it('anchors properties_total on its own label in the run-on stat strip, not a preceding number', () => {
    const html = page(`
      <section id="member-header-details">
        <span>Headquarters</span> <span>Gatlinburg, TN</span>
        <span>Founded In</span> <span>2010</span>
        <span>Number of Full Time Employees</span> <span>14</span>
        <span>Total managed properties</span> <span>95</span>
        <span>Markets Served</span> <span>3</span>
      </section>
    `)

    const rec = extractProfile(html, URL)

    expect(rec.portfolio_size).toBe(95)
    expect(rec.portfolio_size_source).toBe('header_total')
  })

  it('reads name/phone/address from a well-formed ListItem>LocalBusiness JSON-LD block', () => {
    const html = page(`
      <script type="application/ld+json">
        {"@type":"ListItem","item":{"@type":"LocalBusiness","name":"Smoky Mountain Escapes","telephone":"8655551234","address":{"streetAddress":"200 Ski Mountain Rd","addressLocality":"Gatlinburg","addressRegion":"TN","postalCode":"37738"}}}
      </script>
    `)

    const rec = extractProfile(html, URL)

    expect(rec.company_name).toBe('Smoky Mountain Escapes')
    expect(rec.phone).toBe('8655551234')
    expect(rec.city).toBe('Gatlinburg')
    expect(rec.state).toBe('TN')
  })

  // The bug this pins: comparent emits unescaped quotes into its own
  // JSON-LD prose (an answer reading `we affectionately call "The Family
  // Room"`), so JSON.parse throws on exactly the richest profiles. The
  // regex fallback over the raw source must still recover name/phone.
  it('falls back to a raw-source regex when the JSON-LD block has unescaped quotes', () => {
    const html = page(`
      <script type="application/ld+json">
        {"@type":"ListItem","item":{"@type":"LocalBusiness","name":"Smoky Mountain Escapes","telephone":"8655551234","description":"we affectionately call "The Family Room" our favorite"}}
      </script>
    `)

    const rec = extractProfile(html, URL)

    expect(rec.company_name).toBe('Smoky Mountain Escapes')
    expect(rec.phone).toBe('8655551234')
  })

  // The bug this pins: "first external link that isn't a CDN" once returned
  // comparent's own R2 asset bucket as a company's website. A wrong domain
  // is worse than a blank one, since it's the join key everything else
  // keys on — this must come back null, not the R2 host.
  it('never returns a CDN/object-store host as the website', () => {
    const html = page(`
      <a href="https://pub-abc123def.r2.dev/photos/hero.jpg">hero photo</a>
      <a href="https://comparent.com/str/tn/gatlinburg">back to directory</a>
    `)

    const rec = extractProfile(html, URL)

    expect(rec.website).toBeNull()
    expect(rec.domain).toBeNull()
  })

  it('finds the utm-tagged "Visit Website" CTA first, when present', () => {
    const html = page(`
      <a href="https://www.smokymountainescapes.com/?utm_source=comparent&utm_medium=profile">Visit Website</a>
    `)

    const rec = extractProfile(html, URL)

    expect(rec.website).toBe('https://www.smokymountainescapes.com')
    expect(rec.domain).toBe('smokymountainescapes.com')
    expect(rec.website_source).toBe('utm_cta')
  })

  // The bug this pins: a stub profile has no outbound CTA, so the only
  // trace of the company's own domain is an image hotlinked straight off
  // their site. This must be accepted ONLY when the host echoes the
  // company name — never as a bare "first non-CDN link" rule.
  it('falls back to a name-matching hotlinked asset when there is no CTA', () => {
    const html = page(`
      <img src="https://www.staywithstylescottsdale.com/wp-content/uploads/logo.png">
    `)
    const withName = html.replace('Smoky Mountain Escapes', 'Stay With Style Scottsdale')

    const rec = extractProfile(withName, URL)

    expect(rec.website).toBe('https://www.staywithstylescottsdale.com')
    expect(rec.website_source).toBe('name_match_asset')
  })

  it('does not accept a hotlinked asset whose host does not echo the company name', () => {
    const html = page(`
      <img src="https://images.unrelatedvendor.example/cdn/photo.jpg">
    `)

    const rec = extractProfile(html, URL)

    expect(rec.website).toBeNull()
  })

  it('falls back to summing markets_served when there is no header total', () => {
    const html = page(`
      <section id="markets_served">
        <h4>65 Properties in Tennessee</h4>
        <p>40 in Gatlinburg</p>
        <p>25 in Pigeon Forge</p>
      </section>
    `)

    const rec = extractProfile(html, URL)

    expect(rec.portfolio_size).toBe(65)
    expect(rec.portfolio_size_source).toBe('markets_served')
  })

  it('recovers state from the URL when addressRegion is blank', () => {
    const html = page('<p>no structured address here</p>')

    const rec = extractProfile(html, URL)

    expect(rec.state).toBe('TN')
  })

  it('returns nulls for every field on a bare stub profile', () => {
    const html = page('<p>Claimed but not filled in.</p>')

    const rec = extractProfile(html, URL)

    expect(rec.portfolio_size).toBeNull()
    expect(rec.website).toBeNull()
    expect(rec.phone).toBeNull()
  })
})

describe('isComparentUrlAllowed', () => {
  it('allows an ordinary profile URL', () => {
    expect(isComparentUrlAllowed(URL)).toBe(true)
  })

  it('refuses a non-comparent.com host', () => {
    expect(isComparentUrlAllowed('https://evil.example/str/tn/gatlinburg/x')).toBe(false)
  })

  it('refuses a robots.txt-disallowed path', () => {
    expect(isComparentUrlAllowed('https://comparent.com/api/internal')).toBe(false)
    expect(isComparentUrlAllowed('https://comparent.com/writeareview/x')).toBe(false)
    expect(isComparentUrlAllowed('https://comparent.com/connect/x')).toBe(false)
  })

  it('rejects an unparseable URL rather than throwing', () => {
    expect(isComparentUrlAllowed('not a url')).toBe(false)
  })
})
