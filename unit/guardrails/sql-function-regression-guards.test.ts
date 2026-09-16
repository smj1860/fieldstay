import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import { ROOT, balancedEnd } from './scan'

// Non-recursive, matching migration-hygiene.test.ts's convention — critically,
// this is what keeps supabase/migrations/_unshipped/ out of consideration.
// Those files are historical drift artifacts explicitly never applied (see
// its README.md); one of them (20260714140000_crew_vendor_score_recompute_
// rpcs.sql) also defines apply_crew_score_recompute(), and a recursive walk
// sorted by full path put it "after" the real 2026-09 migrations purely
// because '_unshipped' sorts after digits as a path segment — which would
// have made this guardrail check dead reference material instead of the
// live definition.
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))

// ============================================================================
// Guardrail: two specific, already-shipped-and-fixed SQL regressions from the
// 2026-09 scalability audit must not silently reappear the next time someone
// CREATE OR REPLACEs the same function.
//
// Both were "grew back" defects, not typos — a full-table scan or an
// unwindowed aggregate reads as completely reasonable code in isolation, and
// nothing about the SQL itself looks wrong. The only way to catch a
// REGRESSION is to check the specific property the fix established, against
// whichever migration currently holds the live definition. Migrations are
// append-only, so "the file that last CREATE OR REPLACEs this function, by
// filename" is the only way to ask "what does this function do today" from
// source alone — the same reasoning `latest ledger version` uses everywhere
// else in this repo's tooling.
//
//  - next_wo_number(): 20260818161500 added a
//    `SELECT MAX(...) FROM work_orders` self-heal scan that ran, regex-
//    filtered, over every work order an org had EVER created, ON EVERY
//    SINGLE INSERT, under an org-wide advisory lock — the single
//    highest-severity finding in the audit. 20260916000000_wo_number_drop_
//    selfheal_scan.sql removed it deliberately, trusting wo_number_counters
//    as the sole source of truth. A future "helpful" re-add of that scan
//    (e.g. to patch some counter-drift edge case) would reintroduce the
//    exact O(n)-per-insert tax the fix exists to remove, on the
//    highest-write-volume table in the app.
//  - apply_crew_score_recompute(): its capacity-score CTE was an unwindowed
//    full-table aggregate over assignment_outcomes — every crew member's
//    ENTIRE lifetime, re-aggregated on every single cron run — until
//    20260916002000_crew_score_recompute_capacity_window.sql bounded it to a
//    rolling 180-day window, matching this codebase's established
//    convention for exactly this class of calculation
//    (crew_speed_baselines' 90-day FAMILIARITY_WINDOW_DAYS,
//    checklist-signals' 180-day OBSERVATION_WINDOW_DAYS). Dropping the bound
//    reintroduces a cost that grows with platform age forever.
//
// Each check carries a self-check proving the underlying pattern match
// actually fires on the shape of the original bug — a guardrail that can
// never fail is indistinguishable from a clean tree.
// ============================================================================

/**
 * The body (from `CREATE [OR REPLACE] FUNCTION public.<name>(` through the
 * closing dollar-quote tag) of whichever migration LAST defines `name`, by
 * filename — migration filenames are `YYYYMMDDHHMMSS_...`, so lexicographic
 * sort is chronological sort.
 */
function latestFunctionBody(name: string): { file: string; body: string } | null {
  const createRe = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`)
  const file = migrationFiles
    .filter((f) => createRe.test(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
    .sort() // YYYYMMDDHHMMSS-prefixed filenames — lexicographic sort is chronological
    .at(-1)
  if (!file) return null

  const src = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
  const globalRe = new RegExp(createRe.source, 'g')
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = globalRe.exec(src))) last = m
  if (!last) return null

  // The dollar-quote tag right after AS — `$function$`, `$$`, etc. — varies
  // between migrations in this repo, so it's read rather than assumed.
  const tail     = src.slice(last.index)
  const tagMatch = /AS\s+(\$[a-zA-Z_]*\$)/.exec(tail)
  if (!tagMatch) return null

  const tag     = tagMatch[1]!
  const openIdx = last.index + tagMatch.index! + tagMatch[0].length
  const closeIdx = src.indexOf(tag, openIdx)
  if (closeIdx === -1) return null

  return { file: `supabase/migrations/${file}`, body: src.slice(last.index, closeIdx + tag.length) }
}

describe('guardrail: SQL regressions the 2026-09 scalability audit already fixed', () => {
  it('next_wo_number() never re-reads work_orders — wo_number_counters is the sole source', () => {
    const def = latestFunctionBody('next_wo_number')
    expect(def, 'next_wo_number() is not defined by any migration in supabase/migrations/').not.toBeNull()

    expect(
      /FROM\s+work_orders/i.test(def!.body),
      `${def!.file} (the current definition of next_wo_number()) reads from work_orders. ` +
        'This is the self-heal scan removed by ' +
        '20260916000000_wo_number_drop_selfheal_scan.sql specifically because it ran, ' +
        "regex-filtered, over an org's ENTIRE work-order history on every single insert — " +
        'the highest-severity finding in the 2026-09 scalability audit. If a counter-drift ' +
        'bug needs fixing, fix it at the write site that skipped wo_number_counters, not by ' +
        'bringing this scan back.',
    ).toBe(false)
  })

  it('self-check: the work_orders self-heal-scan pattern is actually detected', () => {
    const offender = `
      CREATE OR REPLACE FUNCTION public.next_wo_number(p_org_id uuid)
      RETURNS text LANGUAGE plpgsql AS $function$
      DECLARE v_number integer;
      BEGIN
        SELECT MAX(NULLIF(regexp_replace(wo_number, '^WO-\\d{4}-', ''), '')::integer)
          INTO v_number FROM work_orders WHERE org_id = p_org_id;
      END;
      $function$;
    `
    expect(/FROM\s+work_orders/i.test(offender)).toBe(true)
  })

  it("apply_crew_score_recompute()'s capacity CTE stays windowed, not a lifetime aggregate", () => {
    const def = latestFunctionBody('apply_crew_score_recompute')
    expect(def, 'apply_crew_score_recompute() is not defined by any migration in supabase/migrations/').not.toBeNull()

    const capacityIdx = def!.body.indexOf('capacity AS (')
    expect(
      capacityIdx,
      `${def!.file} no longer has a 'capacity AS (' CTE — update this guardrail to match ` +
        'wherever the capacity-score calculation moved to; do not delete the check.',
    ).toBeGreaterThan(-1)

    const openParen   = def!.body.indexOf('(', capacityIdx)
    const capacityCte = def!.body.slice(capacityIdx, balancedEnd(def!.body, openParen))

    expect(
      /completed_at\s*>=\s*now\(\)\s*-\s*interval/i.test(capacityCte),
      `${def!.file}'s capacity CTE has no rolling-window bound on completed_at. This is the ` +
        'unwindowed full-table aggregate fixed by ' +
        "20260916002000_crew_score_recompute_capacity_window.sql — a crew member's ENTIRE " +
        'lifetime of assignments re-aggregated on every cron run, a cost that only grows with ' +
        'platform age. Every sibling crew-scoring calculation in this codebase rolls a bounded ' +
        'window for exactly this reason (crew_speed_baselines: 90 days, checklist-signals: ' +
        '180 days) — see CLAUDE.md.',
    ).toBe(true)
  })

  it('self-check: an unwindowed capacity CTE is actually detected', () => {
    const offender = `
      WITH capacity AS (
        SELECT crew_member_id,
               count(*) FILTER (WHERE property_bedrooms >= 4) AS large_count,
               count(*) AS total_count
        FROM assignment_outcomes
        WHERE property_bedrooms IS NOT NULL AND completed_at IS NOT NULL
        GROUP BY crew_member_id
        HAVING count(*) >= 3
      )
    `
    expect(/completed_at\s*>=\s*now\(\)\s*-\s*interval/i.test(offender)).toBe(false)
  })
})
