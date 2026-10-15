import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BREEZEWAY_COMPETITORS, type ComparisonRow } from '@/app/breezeway-alternative/comparison-data'

// ============================================================================
// Every "<competitor> alternative" page makes claims about a live competitor's
// product, so every competitor-side cell must say where it was checked and
// when, and the page-level RESEARCHED_ON must be the OLDEST of those dates.
//
// That last rule is the whole point. RESEARCHED_ON renders as "checked on or
// after", and bumping it to the newest date by hand would assert a sweep that
// never happened. Expressed as a test, it cannot be bumped by hand.
//
// /breezeway-alternative predates this rule, carries its own dates in free
// text, and is deliberately excluded; migrating it is a separate ticket.
// ============================================================================

// Directories are discovered rather than listed, so a new page is picked up
// with no registry to forget. The import path keeps a relative prefix and a
// file extension in its static part, which is what Vite needs to analyse it.
const ALTERNATIVE_DIRS = readdirSync(join(process.cwd(), 'app')).filter(
  (d) =>
    d.endsWith('-alternative') &&
    d !== 'breezeway-alternative' &&
    existsSync(join(process.cwd(), 'app', d, 'comparison-data.ts')),
)

const load = async (dir: string) =>
  (await import(`../../app/${dir}/comparison-data.ts`)) as DataModule

const DATE = /checked (\d{4}-\d{2}-\d{2})/g

interface DataModule {
  RESEARCHED_ON:  string
  COMPARISON_ROWS: readonly ComparisonRow[]
}

describe('competitor comparison pages cite what they claim', () => {
  it('finds at least one alternative page, or this guardrail is scanning nothing', () => {
    expect(ALTERNATIVE_DIRS.length).toBeGreaterThan(0)
  })

  for (const dir of ALTERNATIVE_DIRS) {
    describe(`/${dir}`, () => {
      it('every competitor-side source carries a "checked YYYY-MM-DD" date', async () => {
        const mod = await load(dir)
        for (const row of mod.COMPARISON_ROWS) {
          expect(
            row.breezewaySource,
            `"${row.category}" cites no check date; write "checked YYYY-MM-DD" in its source`,
          ).toMatch(/checked \d{4}-\d{2}-\d{2}/)
        }
      })

      it('RESEARCHED_ON is no newer than the oldest row date (oldest-not-newest)', async () => {
        const mod = await load(dir)
        const dates = mod.COMPARISON_ROWS.flatMap((r) =>
          [...r.breezewaySource.matchAll(DATE)].map((m) => m[1]),
        ).sort((a, b) => a.localeCompare(b))

        expect(dates.length).toBeGreaterThan(0)
        expect(
          mod.RESEARCHED_ON <= dates[0],
          `RESEARCHED_ON ${mod.RESEARCHED_ON} is newer than the oldest row date ${dates[0]}`,
        ).toBe(true)
      })
    })
  }
})

describe('every alternative page is linked from the Breezeway competitors section', () => {
  it("each page's path is the alternativePath of an entry in BREEZEWAY_COMPETITORS", () => {
    const linked = new Set(BREEZEWAY_COMPETITORS.map((c) => c.alternativePath))
    for (const dir of ALTERNATIVE_DIRS) {
      expect(linked.has(`/${dir}`), `/${dir} has no entry with that alternativePath in BREEZEWAY_COMPETITORS`).toBe(true)
    }
  })
})
