import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ROOT } from '../guardrails/scan'

// ============================================================================
// The GA4 install has four parts that must agree, in four different files.
// Each can be broken on its own with no visible symptom — the page renders,
// nothing errors, and no data arrives. That is the whole reason this exists.
//
//   app/layout.tsx      builds the googletagmanager tag URL from the id
//   public/gtag-init.js calls gtag('config', <id>) with the same id
//   proxy.ts            must permit BOTH the tag host and the collect hosts
//
// A mismatched id loads a tag for one property and configures another. A
// missing CSP entry blocks the script or the beacons silently — the browser
// logs to the console and the page looks perfectly fine.
// ============================================================================

const layout   = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8')
const bootstrap = readFileSync(join(ROOT, 'public/gtag-init.js'), 'utf8')
const proxy    = readFileSync(join(ROOT, 'proxy.ts'), 'utf8')

const MEASUREMENT_ID = /G-[A-Z0-9]+/

describe('GA4 install', () => {
  it('layout and bootstrap name the SAME measurement id', () => {
    const inLayout    = MEASUREMENT_ID.exec(layout)?.[0]
    const inBootstrap = MEASUREMENT_ID.exec(bootstrap)?.[0]

    expect(inLayout).toBeTruthy()
    expect(inBootstrap).toBeTruthy()
    expect(inLayout).toBe(inBootstrap)
  })

  it('the bootstrap is an EXTERNAL file, not inlined into the layout', () => {
    // An inline snippet would need 'unsafe-inline' in script-src on every
    // nonce'd route, undoing what buildCsp exists for. Same rule as
    // /theme-init.js.
    expect(layout).toContain('src="/gtag-init.js"')
    expect(layout).not.toContain('dataLayer.push')
  })

  it('only fires on production, so previews and local runs stay out of the property', () => {
    expect(layout).toContain("process.env.VERCEL_ENV === 'production'")
  })

  it('CSP permits the tag host in script-src', () => {
    const scriptSrc = proxy
      .split('\n')
      .filter((l) => l.includes('script-src'))
      .join('\n')

    expect(scriptSrc).toContain('https://*.googletagmanager.com')
  })

  it('CSP permits every GA4 collect host in connect-src', () => {
    const connectSrc = proxy
      .split('\n')
      .find((l) => l.includes('"connect-src')) ?? ''

    // www.google-analytics.com alone is NOT enough — GA4 sends most beacons to
    // regionN.google-analytics.com and *.analytics.google.com.
    for (const host of [
      'https://*.google-analytics.com',
      'https://*.analytics.google.com',
      'https://*.googletagmanager.com',
    ]) {
      expect(connectSrc).toContain(host)
    }
  })
})
