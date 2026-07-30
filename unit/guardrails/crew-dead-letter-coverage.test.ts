import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CREW_SYNCED_TABLES } from '../../lib/dexie/schema'

// Two invariants the pre-launch audit found violated across almost the whole
// crew write surface:
//
//  1. DEAD-LETTER UI — every mutation type that can dead-letter must be
//     surfaced somewhere the crew member can see and retry it. Retry
//     affordances used to exist for exactly three of nine mutation types;
//     checklist item ticks (the highest-volume crew write), inventory
//     counts, availability, WO reports, asset captures and turnover
//     start/complete all dead-lettered in total silence.
//  2. PRUNING — every cached Supabase-backed table must be bounded, either
//     by pull-time reconciliation or by lib/dexie/prune.ts. Only three of
//     nine were; `messages` grew forever at 500 rows a pull.

const ROOT = join(__dirname, '..', '..')

const SCHEMA_SRC  = readFileSync(join(ROOT, 'lib', 'dexie', 'schema.ts'), 'utf8')
const BANNER_SRC  = readFileSync(join(ROOT, 'app', 'crew', '_components', 'failed-sync-banner.tsx'), 'utf8')
const PRUNE_SRC   = readFileSync(join(ROOT, 'lib', 'dexie', 'prune.ts'), 'utf8')

/** Every member of the MutationTable union in lib/dexie/schema.ts. */
function mutationTables(): string[] {
  const decl = SCHEMA_SRC.slice(SCHEMA_SRC.indexOf('export type MutationTable ='))
  const body = decl.slice(0, decl.indexOf('\n\n'))
  return [...body.matchAll(/\|\s*'(\w+)'/g)].map((m) => m[1]!)
}

/**
 * Tables bounded by pull-time reconciliation rather than by prune.ts —
 * their sync function fetches the full current id set and bulkDeletes
 * anything local that is no longer in it. Each entry names the file that
 * does it, and the test verifies that file really does reconcile.
 */
const RECONCILED_AT_PULL: Readonly<Record<string, string>> = {
  turnovers:                'lib/dexie/sync/turnovers.ts',
  checklist_instances:      'lib/dexie/sync/turnovers.ts',
  checklist_instance_items: 'lib/dexie/sync/turnovers.ts',
  crew_work_orders:         'lib/dexie/sync/work-orders.ts',
}

describe('guardrail: every crew mutation type has a dead-letter surface', () => {
  it('MUTATION_LABELS in the failed-sync banner covers every MutationTable member', () => {
    const tables = mutationTables()
    expect(tables.length, 'failed to parse the MutationTable union — has its shape changed?').toBeGreaterThan(5)

    const labelBlock = BANNER_SRC.slice(BANNER_SRC.indexOf('MUTATION_LABELS'))
    const missing = tables.filter((t) => !new RegExp(`\\b${t}:`).test(labelBlock))

    expect(missing, [
      'These mutation types can dead-letter but have no entry in',
      'MUTATION_LABELS (app/crew/_components/failed-sync-banner.tsx), so a',
      'crew member whose write never reached the server would be told',
      'nothing at all. Add a label:',
      ...missing,
    ].join('\n')).toEqual([])
  })

  it('the failed-sync banner is rendered by the crew shell, so it covers every crew screen', () => {
    const shell = readFileSync(join(ROOT, 'app', 'crew', 'crew-shell.tsx'), 'utf8')
    expect(shell).toContain('<FailedSyncBanner')
  })

  it('the banner surfaces failed photo uploads as well as failed mutations', () => {
    expect(BANNER_SRC).toMatch(/pending_photo_uploads[\s\S]{0,200}failed/)
    expect(BANNER_SRC, 'the banner must offer a retry, not just a notice').toContain('retryAllFailedMutations')
    expect(BANNER_SRC).toContain('retryFailedPhotoUploads')
  })
})

describe('guardrail: every cached crew table is bounded', () => {
  it('is pruned by prune.ts or reconciled at pull time', () => {
    const uncovered = Object.keys(CREW_SYNCED_TABLES).filter((dexieTable) => {
      if (dexieTable in RECONCILED_AT_PULL) return false
      // prune.ts must actually reference the table.
      return !new RegExp(`db\\.${dexieTable}\\b`).test(PRUNE_SRC)
    })

    expect(uncovered, [
      'These cached Dexie tables have no pruning at all — they are bulkPut-only',
      'and grow without bound on a device that stays logged in. Either add them',
      'to pruneLocalCache() in lib/dexie/prune.ts, or reconcile deletions in',
      'their pull and record that in RECONCILED_AT_PULL in this file:',
      ...uncovered,
    ].join('\n')).toEqual([])
  })

  it('every RECONCILED_AT_PULL claim is backed by a real bulkDelete in that file', () => {
    for (const [table, file] of Object.entries(RECONCILED_AT_PULL)) {
      const src = readFileSync(join(ROOT, file), 'utf8')
      expect(
        new RegExp(`db\\.${table}\\.bulkDelete`).test(src),
        `${file} is claimed to reconcile deletions for ${table} but has no db.${table}.bulkDelete — the claim is stale`,
      ).toBe(true)
    }
  })

  it('dead letters are retained, not silently collected on sight', () => {
    // The failed-sync surface is built on these rows: collecting them
    // eagerly would re-create the exact silent-loss bug they exist to fix.
    expect(PRUNE_SRC).toContain('DEAD_LETTER_RETENTION_DAYS')
    expect(PRUNE_SRC).toMatch(/failed && m\.createdAt < horizon/)
    expect(PRUNE_SRC).toMatch(/failed && p\.created_at < horizon/)
  })

  it('the logout warning counts only genuinely pending work', () => {
    const shell = readFileSync(join(ROOT, 'app', 'crew', 'crew-shell.tsx'), 'utf8')
    expect(shell).toContain('countPendingSyncWork')
    expect(
      /db\.mutations\.count\(\)/.test(shell),
      'crew-shell counts raw mutation rows again — a dead-lettered row would ' +
      'then fire the unsynced-work warning on every logout forever',
    ).toBe(false)
  })
})
