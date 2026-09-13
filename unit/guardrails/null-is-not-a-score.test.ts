import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { ROOT } from './scan'

// ============================================================================
// "Not applicable" must contribute nothing to a score — and in SQL, the
// obvious way to write that does the opposite.
//
// apply_crew_score_recompute() folds two optional quality ratios into a crew
// member's reliability delta. Both are NULL when they do not apply: a turnover
// with no checklist items has no completion rate, and 0 would read as "totally
// failed" for something that never happened.
//
// The natural shape for that guard is
//
//     COALESCE(CASE WHEN rate < 1.0 THEN <penalty> ELSE <bonus> END, 0)
//
// and it is WRONG. `NULL < 1.0` evaluates to NULL rather than false, so the
// WHEN does not match, the ELSE claims the row, and "not applicable" collects
// the same bonus a flawless turnover gets. The CASE can never return NULL, so
// the COALESCE is dead code that merely looks like a guard — it reviews as
// correct, and nothing fails.
//
// Measured against the live database before this was fixed: a row with NULL
// ratios scored 0.04, identical to a perfect turnover, and a row carrying only
// a pm_rating scored 0.10 where it had always scored 0.08 — so the bug also
// silently changed pm_rating's long-established behaviour.
//
// The fix is to make the NULL check the FIRST branch. This guards that, over
// the migration that owns the function, because the failure is invisible: no
// error, no wrong-looking SQL, just a score that quietly rewards absence.
// ============================================================================

const MIGRATIONS = join(ROOT, 'supabase', 'migrations')

/** The migration that owns apply_crew_score_recompute's quality terms. */
function qualitySignalMigration(): string {
  const file = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse()
    .find((f) => {
      const src = readFileSync(join(MIGRATIONS, f), 'utf8')
      return src.includes('apply_crew_score_recompute') && src.includes('completion_rate')
    })

  expect(file, 'no migration defines apply_crew_score_recompute with completion_rate').toBeDefined()
  return readFileSync(join(MIGRATIONS, file!), 'utf8')
}

describe('guardrail: a NULL ratio scores nothing, not a bonus', () => {
  // read(), not readCode(): the SQL comments here ARE part of what is being
  // protected, and the assertions below target statements rather than prose.
  const sql = qualitySignalMigration()

  it.each(['completion_rate', 'photo_compliance_rate'])(
    '%s is NULL-guarded as the first branch',
    (column) => {
      expect(
        sql,
        `${column} must branch on IS NULL before any comparison — a bare ` +
        `comparison sends NULL to the ELSE and pays it the perfect-score bonus.`,
      ).toMatch(new RegExp(`WHEN\\s+${column}\\s+IS NULL\\s+THEN 0`))
    },
  )

  it.each(['completion_rate', 'photo_compliance_rate'])(
    '%s never uses the dead COALESCE-around-CASE shape',
    (column) => {
      // The exact construct that looks like a guard and is not.
      const deadShape = new RegExp(`COALESCE\\s*\\(\\s*CASE\\s+WHEN\\s+${column}\\s*<`, 's')
      expect(deadShape.test(sql), `${column} is wrapped in a COALESCE that can never fire`).toBe(false)
    },
  )

  it('leaves pm_rating on its own COALESCE, which is correct there', () => {
    // pm_rating's term is arithmetic — (pm_rating - 3) * 0.03 — and arithmetic
    // on NULL yields NULL, so COALESCE genuinely fires. The distinction is the
    // whole lesson: COALESCE guards an expression that can return NULL, not a
    // CASE whose ELSE already swallowed it.
    expect(sql).toMatch(/COALESCE\(\(pm_rating - 3\) \* 0\.03, 0\)/)
  })

  it('skips the quality terms entirely for a missed assignment', () => {
    // A dropped assignment takes the flat -0.15 and no quality delta at all —
    // there is no work to rate.
    expect(sql).toMatch(/WHEN was_missed THEN -0\.15/)
  })
})
