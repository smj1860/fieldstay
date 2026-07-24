import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { ROOT } from './scan'

const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')

const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))

describe('guardrail: migration hygiene', () => {
  it('every migration matches YYYYMMDDHHMMSS_description.sql', () => {
    const malformed = migrationFiles.filter((f) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(f))
    expect(malformed).toEqual([])
  })

  it('migration version prefixes are unique (supabase db push rejects duplicates)', () => {
    // This exact collision happened: 20260722130000 was claimed by two
    // different migrations on two branches and had to be renamed at merge
    // time. Now it fails the moment the second file lands on one branch.
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const f of migrationFiles) {
      const version = f.slice(0, 14)
      const prior = seen.get(version)
      if (prior) collisions.push(`${version}: ${prior} vs ${f}`)
      seen.set(version, f)
    }
    expect(collisions).toEqual([])
  })

  it('every migration that CREATEs a table also enables Row Level Security on it', () => {
    // CLAUDE.md Critical Security Rule #2: every table has RLS, no
    // exceptions. Table-level check: a migration file creating tables must
    // contain at least as many ENABLE ROW LEVEL SECURITY statements as
    // distinct tables it creates — catches the "added a table, forgot the
    // policies file" drift at commit time instead of at pentest time.
    //
    // HISTORICAL_SPLIT_RLS: the 2026-05/early-06 era structured schema as
    // "tables file, then RLS file" — those tables all have RLS live (see
    // Critical Security Rule #2's audit trail); the split files are frozen
    // history and exempt. This list only ever shrinks; new migrations must
    // be self-contained.
    const HISTORICAL_SPLIT_RLS = new Set([
      '20260524165637_fieldstay_v1_core_tables.sql',
      '20260524165702_fieldstay_v1_property_related.sql',
      '20260524165825_fieldstay_v1_crew_vendors_checklists.sql',
      '20260524170107_fieldstay_v1_turnovers.sql',
      '20260524170119_fieldstay_v1_inventory_pos.sql',
      '20260524170130_fieldstay_v1_work_orders_maintenance.sql',
      '20260524170137_fieldstay_v1_guest_messages_owner_txns.sql',
      '20260531181701_integration_framework.sql',
      '20260606043358_create_asset_health_schema.sql',
    ])
    const offenders: string[] = []

    for (const f of migrationFiles) {
      if (HISTORICAL_SPLIT_RLS.has(f)) continue
      const src = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
      // Strip SQL comments so prose mentioning CREATE TABLE doesn't count
      const code = src.replace(/--.*$/gm, '')

      const created = [...code.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public\.)?"?([a-z_]+)"?/gi)]
        .map((m) => m[1]!.toLowerCase())
      if (!created.length) continue

      const rlsEnabled = new Set(
        [...code.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_]+)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)]
          .map((m) => m[1]!.toLowerCase())
      )

      const missing = created.filter((t) => !rlsEnabled.has(t))
      if (missing.length) offenders.push(`${f}: ${missing.join(', ')}`)
    }

    expect(
      offenders,
      'Tables created without ENABLE ROW LEVEL SECURITY in the same migration. If RLS is enabled in a deliberate follow-up migration, enable it here too (idempotent) — the invariant is per-file so it is checkable.'
    ).toEqual([])
  })
})
