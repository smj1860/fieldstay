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

    // `/maintenance/inspections/` was added 2026-08-23, and ONLY with its
    // trailing slash — see the next test. The fill screen's Server Component
    // renders three ids and nothing else, so the HTML cached for it is a frame
    // with no facts in it. Nothing else under /maintenance qualifies: every
    // other page there renders its data on the server.
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
    ].join('\n')).toEqual(['/crew', '/maintenance/inspections/', '/work-orders/'])
  })

  it('the inspections entry keeps its trailing slash, so the LIST stays out', () => {
    // The sharp edge of the 2026-08-23 addition, checked structurally because
    // dropping one character is a plausible tidy-up with no visible symptom.
    //
    // isOfflineCapable tests `pathname === p || pathname.startsWith(p + '/')`,
    // so '/maintenance/inspections/' matches '/maintenance/inspections/<id>'
    // and NOT '/maintenance/inspections'. That exclusion is the whole design:
    // the fill screen is a shell whose values all come from Dexie, while the
    // LIST is an ordinary Server Component that renders its rows on the server.
    // Caching the list would serve a PM an inspection roster from last Tuesday
    // — including, at its worst, hiding the inspection they just started.
    const list  = /const OFFLINE_PATHS = \[([\s\S]*?)\]/.exec(code)
    const paths = [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1]!)

    const entry = paths.find((p) => p.includes('/maintenance/'))
    expect(entry, 'the inspections entry is gone').toBeDefined()
    expect(entry, [
      'The /maintenance allowlist entry lost its trailing slash.',
      '',
      'Without it the entry also matches /maintenance/inspections itself — the',
      'LIST page, a Server Component that renders its rows on the server. Its',
      'cached HTML would then be served offline as current, which can hide an',
      'inspection the PM started minutes ago.',
    ].join('\n')).toBe('/maintenance/inspections/')

    // And the parent must not be listed alongside it, which would achieve the
    // same thing by a different route.
    expect(paths, '/maintenance is allowlisted wholesale').not.toContain('/maintenance')
    expect(paths, 'the inspections LIST is allowlisted').not.toContain('/maintenance/inspections')
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
