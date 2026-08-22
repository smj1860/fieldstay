import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  RETENTION_PROTECTED_TABLE_NAMES,
  RETENTION_PROTECTED_TABLES,
  RETENTION_SWEEPABLE_TABLES,
} from '@/lib/retention/registry'

// ============================================================================
// NO RETENTION SWEEP MAY DELETE AN INSPECTION.
//
// An inspection is evidence for an insurance discount, and §1 of
// docs/INSPECTIONS_SPEC.md is explicit that the artifact is the unbroken
// multi-year history rather than any single report. It is also explicit that a
// complete record has to show the GAPS — which means a deleted quarter and a
// quarter that was never inspected look identical, and the first one is
// undetectable after the fact.
//
// Five sweeps already run on a schedule and none touches these tables today.
// The risk is entirely prospective, which is exactly why the spec says to close
// it in the same PR that creates the tables: cheap now, unrecoverable later.
//
// THIS FILE IS HALF THE ENFORCEMENT. The existing sweeps delete through BOTH
// `.from().delete()` and SECURITY DEFINER RPCs — purge_expired_audit_events,
// cleanup_webhook_dedup, cleanup_expired_oauth_states. A source scan cannot see
// a future `purge_old_inspections()` at all. The other half is
// `public.retention_protected_table_violations()`, checked by the db-invariants
// job, which reads pg_get_functiondef for the same patterns.
// ============================================================================

const CRON_DIR = 'lib/inngest/functions/cron'
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

/** Files whose job is to remove data on a schedule. */
function sweepFiles(): string[] {
  return readdirSync(join(process.cwd(), CRON_DIR))
    .filter((f) => /retention|cleanup|purge|prune|sweep/i.test(f))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${CRON_DIR}/${f}`)
}

/** Comment lines stripped — these files describe what they delete in prose. */
function stripComments(src: string): string {
  let inBlock = false
  return src.split('\n').map((line) => {
    const t = line.trim()
    if (inBlock) { if (t.includes('*/')) inBlock = false; return '' }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return '' }
    return (t.startsWith('//') || t.startsWith('*')) ? '' : line
  }).join('\n')
}

describe('guardrail: inspections are excluded from every retention sweep', () => {
  it('no sweep references an inspections table at all', () => {
    const offenders: string[] = []

    for (const file of sweepFiles()) {
      const code = stripComments(read(file))
      for (const table of RETENTION_PROTECTED_TABLE_NAMES) {
        // Deliberately broader than `.delete()`: a sweep that merely SELECTS
        // these to build a delete list is already the wrong shape, and catching
        // the reference is both simpler and stricter than trying to parse which
        // verb it ends in.
        if (new RegExp(`['"\`]${table}['"\`]`).test(code)) {
          offenders.push(`${file} -> ${table}`)
        }
      }
    }

    expect(offenders, [
      'A retention sweep references a protected inspections table.',
      '',
      'These rows are insurance evidence whose value IS the unbroken history —',
      'and because a complete record must show its gaps, a swept quarter is',
      'indistinguishable from one that never happened. There is no recovery and',
      'no signal.',
      '',
      'If a sweep genuinely needs to touch one, that is a product decision about',
      'the evidentiary claim in §1 of the spec, not a cleanup task.',
    ].join('\n')).toEqual([])
  })

  it('every table a sweep deletes from is registered as sweepable', () => {
    // The inverse direction, and the one that keeps the registry honest: a new
    // sweep against an unregistered table fails here, so the decision is made
    // rather than discovered. Without this the registry rots into a list
    // someone wrote once.
    const known = new Set<string>(RETENTION_SWEEPABLE_TABLES)
    const unregistered: string[] = []

    for (const file of sweepFiles()) {
      const code = stripComments(read(file))
      // Requires an actual .delete() after the .from(), unlike the protected
      // scan above. These files legitimately READ tables they never sweep —
      // both comms-retention and guest-pii-retention load `organizations` to
      // find each org's retention window — and flagging those would push
      // someone to register a table as sweepable that nothing sweeps, which is
      // worse than not checking.
      // SPLIT rather than a windowed regex. The obvious
      // `.from\(X\)([\s\S]{0,400}?)(?=\.from\(|$)` is broken in a way that passes
      // its own canary: the lookahead can never resolve for the LAST .from() in
      // a file, because reaching `$` exceeds the window — so the final query in
      // every sweep, which is usually the delete, was never examined at all.
      // Splitting gives each .from() exactly the text up to the next one.
      for (const seg of code.split('.from(').slice(1)) {
        const named = /^\s*['"`]([a-z_]+)['"`]\s*\)/.exec(seg)
        if (!named) continue
        if (!/\.delete\s*\(/.test(seg)) continue
        const table = named[1]!
        if (!known.has(table)) unregistered.push(`${file} -> ${table}`)
      }
    }

    expect(unregistered, [
      'A retention sweep touches a table that is not in RETENTION_SWEEPABLE_TABLES.',
      '',
      'Add it to lib/retention/registry.ts if deleting from it is intended, or',
      'to RETENTION_PROTECTED_TABLES if it is not. The point of the registry is',
      'that the choice is written down somewhere a reviewer will see it.',
    ].join('\n')).toEqual([])
  })

  it('protected and sweepable never overlap', () => {
    const sweepable = new Set<string>(RETENTION_SWEEPABLE_TABLES)
    const both = RETENTION_PROTECTED_TABLE_NAMES.filter((t) => sweepable.has(t))
    expect(both, 'a table cannot be both protected and sweepable').toEqual([])
  })

  it('every protected table carries a REASON, not just a name', () => {
    // A bare list gets pruned by whoever next finds it untidy. The reason is
    // what survives the person who wrote it.
    const missing = RETENTION_PROTECTED_TABLE_NAMES.filter(
      (t) => (RETENTION_PROTECTED_TABLES[t] ?? '').length < 60,
    )
    expect(missing, 'protected tables need a reason explaining why').toEqual([])
  })

  it('the migration declares the exclusion in the DATABASE too', () => {
    // Because the sweeps delete through RPCs as well as the client, and a
    // source scan is blind to a SECURITY DEFINER function. If this helper is
    // ever dropped, the db-invariants half of the enforcement is gone and only
    // this file remains — which would leave exactly the RPC path uncovered.
    const files = readdirSync(join(process.cwd(), 'supabase/migrations'))
      .filter((f) => f.includes('inspections_phase1'))
    expect(files.length, 'the phase 1 migration is missing').toBeGreaterThan(0)

    const sql = read(`supabase/migrations/${files[0]}`)
    expect(sql, 'retention_protected_table_violations() must be defined by the migration')
      .toContain('retention_protected_table_violations')
    for (const t of RETENTION_PROTECTED_TABLE_NAMES) {
      expect(sql, `${t} missing from the DB-side protected list`).toContain(`('${t}')`)
    }
  })

  it('SELF-CHECK: the scan finds real sweep files and would fire', () => {
    // A guardrail at zero because it globbed nothing looks identical to one at
    // zero because the tree is clean.
    const files = sweepFiles()
    expect(files.length, 'no retention sweeps found — has the directory moved?').toBeGreaterThanOrEqual(5)
    for (const f of files) expect(read(f).length).toBeGreaterThan(200)

    // And the matcher itself catches what it claims to.
    const fixture = `const x = supabase.from('inspections').delete()`
    expect(new RegExp(`['"\`]inspections['"\`]`).test(fixture)).toBe(true)
  })
})
