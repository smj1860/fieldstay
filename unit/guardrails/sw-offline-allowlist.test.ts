import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// THE SERVICE WORKER MAY ONLY SERVE STALE PAGES WHERE THAT IS THE FEATURE.
//
// public/sw.js is registered at ROOT SCOPE from three places:
//
//   app/crew/crew-shell.tsx                          — the crew PWA
//   app/work-orders/[token]/register-service-worker  — vendor token pages
//   lib/hooks/use-dashboard-push-notifications.ts    — EVERY dashboard page,
//                                                      on mount, before opt-in
//
// `register('/sw.js')` with no options scopes to '/'. Until 2026-08-21 the
// navigate handler had no path test, so it cached every successful navigation
// and served it back whenever the network failed. For crew and vendor pages
// that is deliberate. For the dashboard it was an accident of the push
// registration — a PM at a property with no signal opened /ops and got
// yesterday's board rendered as current, with nothing saying otherwise.
//
// Cache-Control: no-store does not prevent this. The Cache API is not the HTTP
// cache; cache.put() ignores those headers entirely.
//
// Both halves of the fix are silent when broken:
//   - allowlist too WIDE  → stale pages served again, no error, no test fails
//   - allowlist too NARROW → the crew PWA stops working offline, which only
//     shows up at a property with no signal
// ============================================================================

const sw = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8')

/** Source with comments stripped — this file documents what it forbids. */
const code = sw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n')

describe('guardrail: service worker offline allowlist', () => {
  it('gates the navigate handler on an explicit path test', () => {
    expect(code, [
      'public/sw.js caches navigations without checking the path.',
      '',
      'It is registered at root scope from the dashboard on every page load, so',
      'no path test means every dashboard page a PM visits is cached and served',
      'back offline as if it were current.',
    ].join('\n')).toMatch(/isOfflineCapable\s*\(/)
  })

  it('allows exactly the surfaces that are deliberately offline', () => {
    const list = /const OFFLINE_PATHS = \[([\s\S]*?)\]/.exec(code)
    expect(list, 'OFFLINE_PATHS not found — has it been renamed?').not.toBeNull()

    const paths = [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()

    // Both inspection routes were added 2026-08-23. Each is a SHELL: its
    // Server Component resolves ids and nothing else, and every value comes
    // from Dexie — so the cached HTML is a frame with no facts in it, which is
    // the only kind that cannot go stale. Nothing else under /maintenance
    // qualifies; the board still renders its data on the server.
    expect(paths, [
      'The offline allowlist changed.',
      '',
      'Adding a path makes every page under it cacheable and servable when the',
      'network fails. That is only correct where the surface has a local store',
      'and shows held-on-device state — otherwise it renders yesterday as today.',
      '',
      'Removing one silently breaks a PWA that is supposed to work at a property',
      'with no signal.',
      '',
      'If this is intentional, update this list AND say why in sw.js.',
    ].join('\n')).toEqual([
      '/crew', '/maintenance/inspections', '/maintenance/inspections/', '/work-orders/',
    ])
  })

  it('/maintenance is never allowlisted wholesale', () => {
    // The rule that survived the 2026-08-23 change, and the one that matters.
    //
    // This test used to assert the opposite of what it does now: it required
    // the inspections entry to keep a trailing slash SPECIFICALLY so the list
    // page stayed out, on the grounds that the list was a Server Component
    // rendering its rows on the server. That was true when it was written. The
    // list was then rewritten to render from Dexie — it had to be, because a
    // walk can now be STARTED offline and an inspection you cannot see is an
    // inspection you cannot get back to — so the premise is gone and the rule
    // with it. Recorded rather than quietly deleted: a guardrail that stops
    // being true is worth a paragraph explaining why.
    //
    // What is still true is that /maintenance itself must stay out. Its board
    // renders server-side, so caching it serves last Tuesday's work orders as
    // current. `isOfflineCapable` matches `pathname === p` OR the path plus a
    // slash, so a bare '/maintenance' entry would swallow the entire subtree.
    const list  = /const OFFLINE_PATHS = \[([\s\S]*?)\]/.exec(code)
    const paths = [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1]!)

    expect(paths, [
      '/maintenance is allowlisted wholesale. Every page under it — the work-order',
      'board, the work-order detail — would then be cached and served offline as',
      'current, which is the staleness this allowlist exists to prevent. Only',
      'routes that render from Dexie may be listed, and they must be listed',
      'individually.',
    ].join('\n')).not.toContain('/maintenance')

    // Every /maintenance entry must be a real subpath, not the parent.
    for (const p of paths.filter((x) => x.startsWith('/maintenance'))) {
      expect(p.startsWith('/maintenance/inspections'),
        `${p} allowlists more of /maintenance than the inspection routes`).toBe(true)
    }
  })

  it('the per-inspection routes keep their trailing slash', () => {
    // Without it, '/maintenance/inspections' alone would still match the fill
    // screen via the `p + '/'` branch — so this is not about coverage, it is
    // about the two entries meaning different things. The slashed one is what
    // documents that the SUBTREE is offline-capable, and dropping it would make
    // the list entry silently responsible for both.
    const list  = /const OFFLINE_PATHS = \[([\s\S]*?)\]/.exec(code)
    const paths = [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    expect(paths, 'the per-inspection subtree entry is gone')
      .toContain('/maintenance/inspections/')
  })
  it('serves the offline PAGE outside the allowlist, not a cached copy', () => {
    // The distinction that matters: stop serving stale CONTENT, without
    // stopping being a PWA. A non-allowlisted navigation that fails should get
    // /offline.html, never caches.match(request).
    const guard = /if \(!isOfflineCapable\([\s\S]{0,400}?\n    \}/.exec(code)
    expect(guard, 'the non-allowlisted branch is missing').not.toBeNull()

    expect(guard![0]).toContain('OFFLINE_URL')
    expect(guard![0], 'a non-allowlisted path must never be served from cache')
      .not.toMatch(/caches\.match\(\s*request/)
    expect(guard![0], 'a non-allowlisted path must never be written to cache')
      .not.toMatch(/cache\.put/)
  })

  it('SELF-CHECK: the scan reads real code, not stripped comments', () => {
    // A regex over an empty string passes everything.
    expect(code.length).toBeGreaterThan(500)
    expect(code).toContain("addEventListener('fetch'")
  })
})

// ============================================================================
// /maintenance ITSELF — EXACT MATCH ONLY, EVER.
//
// The board (maintenance-board.tsx) started rendering from Dexie on
// 2026-08-28, so it now qualifies for the allowlist by the same rule the
// inspection routes did. But OFFLINE_PATHS' own matching turns a bare entry
// into a PREFIX — exactly right for '/maintenance/inspections', exactly wrong
// here, because '/maintenance/[id]' (one work order's detail page) starts
// with '/maintenance/' and is STILL server-rendered. Prefix-matching the
// board would silently start caching and replaying a stale copy of that page
// — precisely the bug class this whole file exists to catch, reintroduced by
// the fix for a different page.
//
// So the board lives in a SEPARATE array, OFFLINE_EXACT_PATHS, checked by
// strict equality only. These tests exercise the REAL matching function
// rather than re-deriving its logic in regex, by extracting it from the
// actual file and executing it — a structural check on the array contents
// cannot catch a mistake in how the two arrays are actually combined.
// ============================================================================

/**
 * Extracts and executes the real `isOfflineCapable` from the live file, with
 * its two supporting consts. `new Function` rather than `eval` so nothing
 * leaks into this test file's own scope, and no `self`/`caches`/`fetch`
 * shimming is needed — the function under test touches none of them.
 */
function realIsOfflineCapable(): (pathname: string) => boolean {
  const pathsMatch    = /const OFFLINE_PATHS = \[[\s\S]*?\]/.exec(sw)?.[0]
  const exactMatch    = /const OFFLINE_EXACT_PATHS = \[[\s\S]*?\]/.exec(sw)?.[0]
  const functionMatch = /function isOfflineCapable[\s\S]*?\n\}/.exec(sw)?.[0]

  if (!pathsMatch || !exactMatch || !functionMatch) {
    throw new Error('Could not extract isOfflineCapable and its arrays from public/sw.js — have they been renamed?')
  }

  // Extracting and running the REAL matcher is the point; see the block
  // comment above.
  return new Function(`${pathsMatch}\n${exactMatch}\n${functionMatch}\nreturn isOfflineCapable`)()
}

describe('guardrail: /maintenance offline caching is exact-match only', () => {
  it('the board itself is offline-capable', () => {
    expect(realIsOfflineCapable()('/maintenance')).toBe(true)
  })

  it('a work order detail page is NOT swept in by the board entry', () => {
    // The failure this whole block exists to catch: adding '/maintenance' to
    // the WRONG list would make this true, and every single-work-order page
    // would then be cached and replayed as current forever.
    expect(realIsOfflineCapable()('/maintenance/some-work-order-id')).toBe(false)
  })

  it('the inspection routes are unaffected by the new list', () => {
    expect(realIsOfflineCapable()('/maintenance/inspections')).toBe(true)
    expect(realIsOfflineCapable()('/maintenance/inspections/insp-1')).toBe(true)
  })

  it('OFFLINE_EXACT_PATHS holds only /maintenance today', () => {
    // Not a permanent restriction — a future exact-match route is fine to add
    // — but a change here is exactly the kind of thing a reviewer should see
    // named in a failing test rather than discover by reading a diff.
    const list  = /const OFFLINE_EXACT_PATHS = \[([\s\S]*?)\]/.exec(code)
    expect(list, 'OFFLINE_EXACT_PATHS not found — has it been renamed?').not.toBeNull()
    const paths = [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(paths).toEqual(['/maintenance'])
  })
})
