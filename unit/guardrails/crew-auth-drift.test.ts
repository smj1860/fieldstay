import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

// Guardrail for the requireCrewMember drift class (2026-07-22 audit finding #1).
//
// The canonical crew auth gate (lib/crew-auth.ts) deliberately filters
// crew_members on is_active ONLY — ~a third of live crew rows have
// invite_accepted_at IS NULL (onboarded outside the invite-link flow), so a
// crew_members auth lookup that adds .not('invite_accepted_at', 'is', null)
// silently locks those real crew members out. This exact drift shipped as a
// live bug FOUR times (app/crew/turnovers/actions.ts, app/api/crew/feedback,
// app/api/crew/work-order-reports, app/crew/layout.tsx) before being swept.
//
// This test scans every source file and fails if any crew_members query is
// followed within its builder chain by the lockout filter. The PM-side
// organization_members queries are unaffected — filtering invite_accepted_at
// there is correct and required.

const ROOT = join(__dirname, '..', '..')
const SCAN_DIRS = ['app', 'lib', 'components']

// .not('invite_accepted_at', 'is', null) within 12 lines of .from('crew_members')
const CREW_FROM   = /\.from\(\s*['"]crew_members['"]\s*\)/
const LOCKOUT     = /\.not\(\s*['"]invite_accepted_at['"]\s*,\s*['"]is['"]\s*,\s*null\s*\)/
const CHAIN_REACH = 12

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out)
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('crew auth drift guardrail', () => {
  it('no crew_members query anywhere filters on invite_accepted_at NOT NULL (locks out ~1/3 of live crew — use lib/crew-auth.ts requireCrewMember instead)', () => {
    const offenders: string[] = []

    for (const scanDir of SCAN_DIRS) {
      for (const file of collectSourceFiles(join(ROOT, scanDir))) {
        const lines = readFileSync(file, 'utf8').split('\n')

        lines.forEach((line, i) => {
          if (!CREW_FROM.test(line)) return
          const chain = lines.slice(i, i + CHAIN_REACH).join('\n')
          if (LOCKOUT.test(chain)) {
            offenders.push(`${relative(ROOT, file)}:${i + 1}`)
          }
        })
      }
    }

    expect(offenders, [
      'crew_members auth lookups must NOT filter on invite_accepted_at —',
      '~a third of live crew rows have it NULL. Import requireCrewMember',
      'from lib/crew-auth.ts instead of re-implementing the gate. Offenders:',
      ...offenders,
    ].join('\n')).toEqual([])
  })

  // ── The two crew turnover routes drifted, and the drift was the bug ───────
  //
  // start/ and complete/ share a prologue: authenticate, load the turnover
  // scoped to the crew member's own org, confirm they are assigned to it. The
  // start route was hardened to answer a failed READ with 503 rather than 404,
  // because lib/dexie/net.ts classifies 4xx as TERMINAL and >=500 as transient
  // — a 404 on a transient DB error permanently DEAD-LETTERS the crew member's
  // queued mutation. The complete route kept `const { data } = await ...
  // .single()` and went on discarding finished work: job done, PM never saw it
  // finish, cleaning fee never posted.
  //
  // Copying the fix into the second route would have left exactly the shape
  // that allowed the drift, so it lives in one place now. This keeps it there:
  // a new crew turnover route that re-inlines the prologue cannot pick up the
  // next fix either.
  it('crew turnover routes load their context through the shared helper, not by re-inlining it', () => {
    const routes = collectSourceFiles(join(ROOT, 'app', 'api', 'crew', 'turnovers'))
      .filter((f) => f.endsWith('route.ts'))

    expect(routes.length, 'no crew turnover routes found — has the path moved?').toBeGreaterThan(0)

    // Any direct call at all — NOT "calls it and does not also import the
    // helper". The first version of this check used that weaker condition and
    // a canary walked straight through it: a route that re-inlined
    // requireCrewMember() while still importing the helper was reported clean,
    // which is precisely the half-migrated state drift looks like. A route
    // using the helper has no reason to call requireCrewMember itself.
    const offenders = routes.filter((file) =>
      /requireCrewMember\s*\(/.test(readFileSync(file, 'utf8')),
    )

    expect(
      offenders.map((f) => relative(ROOT, f)),
      'These crew turnover routes call requireCrewMember() directly instead of\n' +
      'loadCrewTurnoverContext() from lib/turnovers/crew-route-context.ts. That\n' +
      'helper carries the 503-vs-404 rule the Dexie outbox depends on, the\n' +
      'org-scoped read, and the assignment check. Re-inlining it is how the\n' +
      'start and complete routes diverged in the first place.',
    ).toEqual([])
  })

})
