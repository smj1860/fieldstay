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
})
