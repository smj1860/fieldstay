import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { CREW_SYNCED_TABLES, LOCAL_ONLY_TABLES } from '../../lib/dexie/schema'
import { CREW_RESYNC_COVERAGE } from '../../lib/dexie/sync/full-resync'

// Structural backstop for the Crew Sync v2 convention (CLAUDE.md, Dexie/crew
// section; docs/CREW_SYNC_V2_PHASES.md section 5e): every Supabase-backed
// table the crew PWA caches in Dexie is covered by the safety poll (the full
// resync()/resyncV2() always pulls every synced table) and must ALSO either
// have a broadcast trigger in the crew-sync trigger migration (low-latency
// entities) or be explicitly listed in SAFETY_POLL_ONLY below — a union
// check, not exclusive-or, since a triggered table is deliberately covered
// by both mechanisms. A new cached table fails this test until it's placed
// in lib/dexie/schema.ts's CREW_SYNCED_TABLES/LOCAL_ONLY_TABLES AND (if
// synced) classified below.

const ROOT = join(__dirname, '..', '..')
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')

// Supabase tables covered by a broadcast trigger — see
// supabase/migrations/*crew_sync_broadcast_triggers.sql. turnover_assignments
// has no Dexie table of its own (assignment membership is folded into the
// turnovers scope pull), so it doesn't appear in CREW_SYNCED_TABLES even
// though it IS triggered — kept here anyway so the first test below still
// verifies the migration file actually contains that trigger.
const TRIGGERED_TABLES = [
  'turnover_assignments',
  'turnovers',
  'checklist_instances',
  'checklist_instance_items',
  'work_orders',
]

// Cached remote tables with NO broadcast trigger — freshness relies on the
// safety poll (≤5 min staleness): property_assets deliberately (low-churn,
// wide property→crew fan-out join — docs/CREW_SYNC_V2_PHASES.md section 1);
// inventory_items/properties are pulled inside the turnovers scope pull
// rather than having their own trigger; crew_availability/messages have no
// trigger at all.
const SAFETY_POLL_ONLY = ['property_assets', 'inventory_items', 'properties', 'crew_availability', 'messages']

function findBroadcastMigrationSql(): string {
  const file = readdirSync(MIGRATIONS_DIR).find((f) => f.includes('crew_sync_broadcast'))
  if (!file) {
    throw new Error(
      'No supabase/migrations/*crew_sync_broadcast*.sql file found — did the ' +
      'Crew Sync v2 Phase 2 migration get renamed, moved, or deleted?'
    )
  }
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
}

describe('crew-sync-coverage guardrail', () => {
  it('every TRIGGERED_TABLES entry actually has a trigger in the broadcast migration', () => {
    const sql = findBroadcastMigrationSql()
    const missing = TRIGGERED_TABLES.filter((table) => !new RegExp(`ON public\\.${table}\\b`).test(sql))

    expect(missing, [
      'TRIGGERED_TABLES claims a broadcast trigger exists for these Supabase',
      'tables, but the migration file has none — the list is stale. Missing:',
      ...missing,
    ].join('\n')).toEqual([])
  })

  it('every Supabase-backed Dexie table is covered by a trigger or SAFETY_POLL_ONLY', () => {
    const uncovered = Object.entries(CREW_SYNCED_TABLES)
      .filter(([, supabaseTable]) => !TRIGGERED_TABLES.includes(supabaseTable) && !SAFETY_POLL_ONLY.includes(supabaseTable))
      .map(([dexieTable, supabaseTable]) => `${dexieTable} (backs Supabase table "${supabaseTable}")`)

    expect(uncovered, [
      'These CREW_SYNCED_TABLES entries (lib/dexie/schema.ts) are in neither',
      'TRIGGERED_TABLES nor SAFETY_POLL_ONLY in this file — classify them in',
      'one before merging:',
      ...uncovered,
    ].join('\n')).toEqual([])
  })

  it('every table declared on FieldStayDexie is classified as synced or local-only', () => {
    const schemaSource = readFileSync(join(ROOT, 'lib', 'dexie', 'schema.ts'), 'utf8')
    const classStart = schemaSource.indexOf('class FieldStayDexie')
    const classEnd = schemaSource.indexOf('constructor(userId: string)')
    expect(classStart, 'could not find "class FieldStayDexie" in lib/dexie/schema.ts — has it been renamed?').toBeGreaterThan(-1)
    expect(classEnd, 'could not find the FieldStayDexie constructor in lib/dexie/schema.ts').toBeGreaterThan(classStart)

    const classBody = schemaSource.slice(classStart, classEnd)
    const declaredTables = [...classBody.matchAll(/^\s*(\w+)!:\s*Table</gm)].map((m) => m[1]!)
    // Sanity check on the regex itself, not just the tables it finds — an
    // empty match list means the extraction broke, not that there are no
    // tables (there always are).
    expect(declaredTables.length, 'regex matched zero Table<...> fields on FieldStayDexie — did the class field syntax change?').toBeGreaterThan(0)

    const known = new Set<string>([...Object.keys(CREW_SYNCED_TABLES), ...LOCAL_ONLY_TABLES])
    const unclassified = declaredTables.filter((table) => !known.has(table))

    expect(unclassified, [
      'These Dexie tables are declared on FieldStayDexie but not classified',
      'in CREW_SYNCED_TABLES or LOCAL_ONLY_TABLES (lib/dexie/schema.ts) — a',
      'new cached table must be placed in one of those two sets in the same',
      'PR that adds it:',
      ...unclassified,
    ].join('\n')).toEqual([])
  })
})

// ── The safety poll must exist on the path that actually ships ────────────
//
// The checks above assert the *union* (trigger OR safety poll). That is only
// meaningful if the safety poll is genuinely running. It wasn't: the poll
// lived exclusively on the Crew Sync v2 code path, `NEXT_PUBLIC_CREW_SYNC_V2`
// defaults off, and the v1 path ran resync() only on mount and on `online` —
// so in the shipping configuration messages, crew_availability,
// inventory_items and properties refreshed on page load and nothing else,
// and the union check above was vacuously true for every SAFETY_POLL_ONLY
// table.
//
// Resolution taken (2026-07-30): the flag was NOT flipped — Phase 5's
// two-device acceptance test and soak week (docs/CREW_SYNC_V2_PHASES.md
// §5b-5c) have not been run, and flipping an unvalidated realtime cutover to
// close a guardrail gap would be backwards. Instead both paths now run the
// same full resync (lib/dexie/sync/full-resync.ts) on the same safety-poll
// interval, and these tests assert that against the source rather than
// trusting the flag.

const CONTEXT_SRC = readFileSync(join(ROOT, 'lib', 'dexie', 'context.tsx'), 'utf8')
const RESYNC_SRC = readFileSync(join(ROOT, 'lib', 'dexie', 'sync', 'full-resync.ts'), 'utf8')

describe('crew-sync-coverage guardrail — the safety poll runs on the shipping path', () => {
  it('CREW_RESYNC_COVERAGE matches CREW_SYNCED_TABLES exactly', () => {
    expect(Object.keys(CREW_RESYNC_COVERAGE).sort()).toEqual(Object.keys(CREW_SYNCED_TABLES).sort())
  })

  it('every table CREW_RESYNC_COVERAGE claims is actually pulled by fullCrewResync', () => {
    const missing = [...new Set(Object.values(CREW_RESYNC_COVERAGE))]
      .filter((fn) => !new RegExp(`${fn}\\(`).test(RESYNC_SRC))

    expect(missing, [
      'CREW_RESYNC_COVERAGE names these sync functions, but',
      'lib/dexie/sync/full-resync.ts never calls them — the full resync does',
      'not actually cover the tables they are claimed to cover:',
      ...missing,
    ].join('\n')).toEqual([])
  })

  it('the safety poll is installed unconditionally, not only under the v2 flag', () => {
    const flagBranch = CONTEXT_SRC.indexOf('if (CREW_SYNC_V2)')
    expect(flagBranch, 'could not find the CREW_SYNC_V2 branch in context.tsx').toBeGreaterThan(-1)

    const installCalls = [...CONTEXT_SRC.matchAll(/installSafetyPoll\(/g)].map((m) => m.index!)
    // One call site per path. Both must exist; a single one inside the v2
    // branch is exactly the regression this test exists to catch.
    expect(
      installCalls.length,
      'expected installSafetyPoll() to be called on both the v1 and v2 sync ' +
      'paths in lib/dexie/context.tsx',
    ).toBeGreaterThanOrEqual(2)
    expect(
      installCalls.some((i) => i > flagBranch),
      'no installSafetyPoll() call appears after the CREW_SYNC_V2 branch — ' +
      'the v1 (shipping) path has no safety poll',
    ).toBe(true)

    expect(CONTEXT_SRC).toContain('setInterval(run, SAFETY_POLL_INTERVAL_MS)')
  })

  it('both sync paths resync through the same full-scope pull', () => {
    // Two call sites: v1's resync() and v2's resyncV2(). If one path grows
    // its own bespoke resync body again, the coverage map above stops
    // describing it.
    const calls = [...CONTEXT_SRC.matchAll(/fullCrewResync\(/g)]
    expect(
      calls.length,
      'expected both resync() and resyncV2() in lib/dexie/context.tsx to call fullCrewResync()',
    ).toBeGreaterThanOrEqual(2)
  })

  it('a reconnect resync exists on both paths', () => {
    expect(CONTEXT_SRC).toContain("globalThis.addEventListener('online', onlineHandler)")
    expect([...CONTEXT_SRC.matchAll(/visibilitychange/g)].length).toBeGreaterThanOrEqual(2)
  })
})
