import { describe, it, expect } from 'vitest'
import { readdirSync } from 'fs'
import { join } from 'path'
import { config, classifyRoute } from '@/proxy'

// ============================================================================
// P3-6: the matcher decides what runs middleware AT ALL, and getting it wrong
// fails in two opposite, equally silent directions.
//
//   TOO NARROW — a static asset that is not excluded pays full session
//     resolution on every request, and an anonymous fetch of it gets a 307 to
//     /login instead of the file. That was the old shape: a fixed image-
//     extension list plus a hand-maintained BYPASS_ROUTES entry per file, where
//     the safety net was "someone remembers to add a line".
//
//   TOO WIDE — a route that NEEDS middleware stops running it. That is worse
//     than slow: rateLimiterForPathname() runs at the top of proxy(), so a
//     token route excluded from the matcher silently loses its throttle on
//     exactly the enumeration-prone surfaces the throttle exists for.
//
// Neither direction produces an error anywhere. These tests are the only thing
// that fails.
// ============================================================================

// Read straight off the exported config — the pattern must live inline there
// (Next.js statically parses it at build time), so this is the one copy.
const matcher = new RegExp(`^${config.matcher[0]}$`)
const runsMiddleware = (path: string) => matcher.test(path)

/** Every file actually shipped in /public, read from disk, not listed here. */
function publicFiles(): string[] {
  return readdirSync(join(__dirname, '..', '..', 'public'))
}

describe('middleware matcher: static assets are excluded STRUCTURALLY', () => {
  it('excludes every file in /public without needing a per-file entry', () => {
    // Read from disk on purpose. A hardcoded list here would rot exactly the
    // way BYPASS_ROUTES did, and this test would then pass while the real
    // /public grew a file nobody exempted.
    const files = publicFiles()
    expect(files.length).toBeGreaterThan(5)

    const leaked = files.filter((f) => runsMiddleware(`/${f}`))
    expect(
      leaked,
      `These /public files still run middleware, so each pays full session ` +
      `resolution per request and 307s to /login when fetched anonymously:\n` +
      leaked.map((f) => `  - /${f}`).join('\n'),
    ).toEqual([])
  })

  it('excludes a file extension nobody has added yet', () => {
    // The whole point of the change: structural, not enumerated. These are
    // extensions with NO entry anywhere in the codebase.
    for (const path of ['/fonts.woff2', '/app.css', '/bundle.js.map', '/ads.txt', '/feed.xml']) {
      expect(runsMiddleware(path), `${path} should be exempt`).toBe(false)
    }
  })
})

describe('middleware matcher: anything that needs middleware still runs it', () => {
  it('runs for every app route class', () => {
    for (const path of ['/', '/login', '/signup', '/ops', '/turnovers', '/settings/billing']) {
      expect(runsMiddleware(path), `${path} must run middleware`).toBe(true)
    }
  })

  it('runs for every TOKEN route — this is where their rate limiter lives', () => {
    // rateLimiterForPathname() is applied at the top of proxy(). A token route
    // excluded from the matcher keeps working and silently stops being
    // throttled, which is the failure this test exists for.
    const tokenPaths = [
      '/owner/2f1c9e10-7a3b-4c5d-9e8f-1a2b3c4d5e6f',
      '/work-orders/2f1c9e10-7a3b-4c5d-9e8f-1a2b3c4d5e6f',
      '/g/b/2f1c9e10-7a3b-4c5d-9e8f-1a2b3c4d5e6f',
      '/vendor-connect/2f1c9e10-7a3b-4c5d-9e8f-1a2b3c4d5e6f',
      '/unsubscribe/2f1c9e10-7a3b-4c5d-9e8f-1a2b3c4d5e6f',
      '/api/work-orders/2f1c9e10/complete',
      '/api/guidebook/opt-in',
    ]
    for (const path of tokenPaths) {
      expect(classifyRoute(path), `${path} should classify as a token route`).toBe('token')
      expect(runsMiddleware(path), `${path} must run middleware to be throttled`).toBe(true)
    }
  })

  it('still runs for a token that CONTAINS a dot', () => {
    // Tokens are crypto.randomUUID() and have no dots today. The exclusion is
    // anchored to a single ROOT segment so this does not depend on that
    // staying true — the audit's unanchored `.*\.(js|json|css|…)$` form would
    // have dropped these out of middleware, and with them their throttle.
    for (const path of ['/vendor-connect/abc.map', '/owner/tok.json', '/g/b/tok.css']) {
      expect(runsMiddleware(path), `${path} must still run middleware`).toBe(true)
    }
  })

  it('runs for a nested API path that ends in a segment with no extension', () => {
    expect(runsMiddleware('/api/integrations/health')).toBe(true)
    expect(runsMiddleware('/api/account/delete')).toBe(true)
  })
})

describe('middleware matcher: the excluded set is exactly what we think', () => {
  it('does not exclude a root path merely because it is short', () => {
    // Guards against a pattern that accidentally exempts extensionless roots.
    for (const path of ['/ops', '/help', '/g', '/owner']) {
      expect(runsMiddleware(path), `${path} must run middleware`).toBe(true)
    }
  })

  it('keeps the nested-image exclusion — images may live in subdirectories', () => {
    expect(runsMiddleware('/images/hero.png')).toBe(false)
    expect(runsMiddleware('/_next/image')).toBe(false)
    expect(runsMiddleware('/_next/static/chunk.js')).toBe(false)
  })
})
