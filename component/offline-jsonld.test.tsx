import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { buildJsonLd, serializeJsonLd } from '@/app/offline-turnover-app/json-ld'

// ============================================================================
// Proves the JSON-LD escaping is load-bearing rather than cargo-culted.
//
// The page emits structured data as a <script> TEXT CHILD instead of via
// dangerouslySetInnerHTML, because this codebase has zero uses of that and the
// ESLint rule says raw HTML needs DOMPurify plus a CLAUDE.md update first.
//
// The two controls at the bottom PIN REACT'S ACTUAL BEHAVIOUR, which is not
// what either common assumption says:
//
//   * React does NOT HTML-escape script children. <script> is a raw-text
//     element, so "&" is emitted as "&", not "&amp;". The widely-repeated
//     claim that JSON-LD needs dangerouslySetInnerHTML "because React would
//     corrupt the ampersands" is simply false for this element.
//   * React DOES neutralise "</script" on its own, emitting "</\u0073cript".
//     So the tag-breakout hazard is already handled by the framework.
//
// Which means serializeJsonLd's escaping is defence in depth, not a fix for a
// live bug — and saying so plainly is the point. Both behaviours above are
// React implementation details rather than API contract, and an injection
// boundary that silently depends on one is exactly the kind of implicit
// assumption this repo's guardrails exist to make explicit. If a React upgrade
// changes either, these two tests fail and the decision gets re-made
// deliberately instead of discovered in production.
// ============================================================================

function innerText(html: string): string {
  return html
    .replace(/^<script type="application\/ld\+json">/, '')
    .replace(/<\/script>$/, '')
}

describe('JSON-LD survives React rendering intact', () => {
  it('parses back to exactly the payload that went in', () => {
    const payload = buildJsonLd('https://app.fieldstay.app')
    const html = renderToStaticMarkup(
      <script type="application/ld+json">{serializeJsonLd(payload)}</script>,
    )

    expect(JSON.parse(innerText(html))).toEqual(payload)
  })

  it('keeps the ampersand in "Owner P&L reporting" — the character that breaks the naive version', () => {
    const html = renderToStaticMarkup(
      <script type="application/ld+json">
        {serializeJsonLd(buildJsonLd('https://app.fieldstay.app'))}
      </script>,
    )
    const parsed = JSON.parse(innerText(html))
    const app = parsed['@graph'].find((n: { '@type': string }) => n['@type'] === 'SoftwareApplication')

    expect(app.featureList).toContain('Owner P&L reporting')
  })

  it('React does NOT escape script children — which is exactly why serializeJsonLd must', () => {
    // Control 1: the assumption people usually make about React is wrong here.
    // <script> is a raw-text element, so "&" is emitted as "&", not "&amp;".
    // JSON corruption is therefore NOT the reason to escape.
    const naive = JSON.stringify({ feature: 'Owner P&L reporting' })
    const html  = renderToStaticMarkup(<script type="application/ld+json">{naive}</script>)

    expect(innerText(html)).not.toContain('&amp;')
    expect(JSON.parse(innerText(html)).feature).toBe('Owner P&L reporting')
  })

  it('control 2: React neutralises </script> by itself, so our escaping is belt-and-braces', () => {
    // Pins the behaviour rather than assuming it. React rewrites the closing
    // tag as </\u0073cript so it cannot break out. If a future React stops
    // doing this, THIS test fails — and serializeJsonLd is already the thing
    // standing between that regression and an injection.
    const naive = JSON.stringify({ x: '</script><img src=x onerror=alert(1)>' })
    const html  = renderToStaticMarkup(<script type="application/ld+json">{naive}</script>)

    expect(html).toContain('</\\u0073cript>')
    expect(html).not.toMatch(/<\/script><img/)
  })

  it('makes </script> unrepresentable, so the tag cannot be closed early', () => {
    const html = renderToStaticMarkup(
      <script type="application/ld+json">{serializeJsonLd({ x: '</script><img src=x onerror=alert(1)>' })}</script>,
    )
    const inner = innerText(html)

    expect(inner).not.toContain('</script')
    expect(inner).not.toContain('<img')
    expect(JSON.parse(inner).x).toBe('</script><img src=x onerror=alert(1)>')
  })

  it('every FAQ on the page is in the schema, and vice versa', async () => {
    const { FAQS } = await import('@/app/offline-turnover-app/faq')
    const faqNode = buildJsonLd('https://app.fieldstay.app')['@graph']
      .find((n) => n['@type'] === 'FAQPage') as { mainEntity: { name: string }[] }

    expect(faqNode.mainEntity.map((q) => q.name)).toEqual(FAQS.map((f) => f.question))
  })
})
