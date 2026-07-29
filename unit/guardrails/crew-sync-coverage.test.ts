import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { CREW_SYNCED_TABLES, LOCAL_ONLY_TABLES } from '../../lib/dexie/schema'

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
