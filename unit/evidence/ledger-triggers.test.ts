import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ============================================================================
// THE LEDGER'S IMMUTABILITY, AGAINST A REAL POSTGRES.
//
// "Append-only" is a claim about trigger behaviour, and trigger behaviour is
// exactly what a source-text test cannot see: an earlier draft of the DELETE
// trigger tested `pg_trigger_depth() = 0`, which is never true inside a
// trigger (a direct DELETE arrives at depth 1), so it rejected nothing and every
// text-level check passed. This runs the real migration SQL on a scratch cluster.
//
// Skips cleanly when no Postgres server binaries are installed (the always-on CI
// job may not have them); the structural assertions at the bottom run everywhere.
// ============================================================================

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/15/bin']
  .find((d) => existsSync(join(d, 'initdb')))
const root = process.cwd()
const migration = readFileSync(join(root, 'supabase/migrations/20261014090000_evidence_ledger.sql'), 'utf8')

const ORG = '11111111-1111-4111-8111-111111111111'
const PROP = '22222222-2222-4222-8222-222222222222'
const T1 = '33333333-3333-4333-8333-333333333333'
const T2 = '33333333-3333-4333-8333-333333333334'
const WO = '44444444-4444-4444-8444-444444444444'
const PORT = String(56000 + (process.pid % 1000))

let dataDir = ''
let socketDir = ''
const asRoot = process.getuid?.() === 0

function run(cmd: string, args: string[]): string {
  // initdb/postgres refuse to run as root; drop to the postgres user when we are.
  const [bin, a] = asRoot ? ['su', ['postgres', '-s', '/bin/sh', '-c', [cmd, ...args].map((x) => `'${x}'`).join(' ')]] : [cmd, args]
  return execFileSync(bin, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function sql(text: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync('psql', ['-h', socketDir, '-p', PORT, '-U', 'postgres', '-d', 'ledger', '-X', '-q', '-A', '-t',
      '-v', 'ON_ERROR_STOP=1', '-c', text], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out: out.trim() }
  } catch (err) {
    return { ok: false, out: String((err as { stderr?: string }).stderr ?? err) }
  }
}

const insert = (path: string, extra = '') => sql(
  `INSERT INTO evidence_events(org_id,property_id,kind,source_table,source_id,bucket,storage_path,sha256,captured_at,captured_by_kind,turnover_id,work_order_id${extra ? ',' + extra.split('|')[0] : ''})
   VALUES ('${ORG}','${PROP}','photo_sealed','checklist_instance_items','55555555-5555-4555-8555-555555555555','turnover-photos','${path}',repeat('a',64),now(),'crew','${T1}','${WO}'${extra ? ',' + extra.split('|')[1] : ''})`)

describe.skipIf(!BIN)('evidence_events immutability (real Postgres)', () => {
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ev-pg-'))
    socketDir = mkdtempSync(join(tmpdir(), 'ev-sock-'))
    if (asRoot) { for (const d of [dataDir, socketDir]) { chmodSync(d, 0o777); execFileSync('chown', ['postgres', d]) } }
    // -U pins the superuser name. Without it initdb names the role after the OS user, which is
    // 'postgres' locally (we su to it) but the runner's own user on CI, where every psql -U postgres then fails.
    run(join(BIN!, 'initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust'])
    run(join(BIN!, 'pg_ctl'), ['-D', dataDir, '-o', `-p ${PORT} -k ${socketDir} -c listen_addresses=`, '-w', '-l', join(dataDir, 'log'), 'start'])
    execFileSync('psql', ['-h', socketDir, '-p', PORT, '-U', 'postgres', '-qc', 'CREATE DATABASE ledger'])
    execFileSync('psql', ['-h', socketDir, '-p', PORT, '-U', 'postgres', '-d', 'ledger', '-q', '-v', 'ON_ERROR_STOP=1',
      '-f', join(root, 'unit/evidence/ledger-harness.sql'), '-f', join(root, 'supabase/migrations/20261014090000_evidence_ledger.sql')],
    { stdio: 'ignore' })
    sql(`INSERT INTO organizations(id) VALUES ('${ORG}');
         INSERT INTO properties(id,org_id) VALUES ('${PROP}','${ORG}');
         INSERT INTO turnovers(id) VALUES ('${T1}'),('${T2}');
         INSERT INTO work_orders(id) VALUES ('${WO}')`)
  }, 120_000)

  afterAll(() => {
    try { run(join(BIN!, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', 'stop']) } catch { /* already down */ }
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(socketDir, { recursive: true, force: true })
  })

  it('rejects a direct DELETE, for every role (the depth check must not be a no-op)', () => {
    expect(insert('del-1').ok).toBe(true)
    const res = sql(`DELETE FROM evidence_events WHERE storage_path = 'del-1'`)
    expect(res.ok).toBe(false)
    expect(res.out).toContain('append-only')
    expect(sql(`SELECT count(*) FROM evidence_events WHERE storage_path = 'del-1'`).out).toBe('1')
  })

  it('rejects editing the hash or any other column', () => {
    expect(insert('upd-1').ok).toBe(true)
    expect(sql(`UPDATE evidence_events SET sha256 = repeat('b',64) WHERE storage_path='upd-1'`).ok).toBe(false)
    expect(sql(`UPDATE evidence_events SET captured_at = now() WHERE storage_path='upd-1'`).ok).toBe(false)
  })

  it('allows exactly one FK to go non-null to null, and nothing else changing', () => {
    expect(insert('fk-1').ok).toBe(true)
    expect(sql(`UPDATE evidence_events SET turnover_id = NULL WHERE storage_path='fk-1'`).ok).toBe(true)
  })

  it('rejects nulling one FK while repointing another, or nulling two at once', () => {
    expect(insert('fk-2').ok).toBe(true)
    expect(sql(`UPDATE evidence_events SET work_order_id = NULL, turnover_id = '${T2}' WHERE storage_path='fk-2'`).ok).toBe(false)
    expect(sql(`UPDATE evidence_events SET work_order_id = NULL, turnover_id = NULL WHERE storage_path='fk-2'`).ok).toBe(false)
    expect(sql(`SELECT turnover_id::text || work_order_id::text FROM evidence_events WHERE storage_path='fk-2'`).out).toBe(T1 + WO)
  })

  it('lets a parent delete null the FK, and a property delete cascade the rows away', () => {
    expect(insert('casc-1').ok).toBe(true)
    expect(sql(`DELETE FROM work_orders WHERE id = '${WO}'`).ok).toBe(true)
    expect(sql(`SELECT work_order_id IS NULL FROM evidence_events WHERE storage_path='casc-1'`).out).toBe('t')
    expect(sql(`DELETE FROM properties WHERE id = '${PROP}'`).ok).toBe(true)
    expect(sql(`SELECT count(*) FROM evidence_events`).out).toBe('0')
  })
})

describe('ledger migration (structural, runs everywhere)', () => {
  const code = migration.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
  it('tests direct deletes at depth <= 1, never = 0', () => {
    expect(code).toMatch(/pg_trigger_depth\(\) <= 1/)
    expect(code).not.toMatch(/pg_trigger_depth\(\) = 0/)
  })
  it('checks the FK exception one column at a time', () => {
    for (const col of ['turnover_id', 'work_order_id', 'inspection_id', 'refers_to_event_id']) {
      expect(code).toContain(`v_probe.${col} := NEW.${col}`)
    }
  })
  it('creates no policy for a command authenticated holds no grant for', () => {
    expect(code).not.toMatch(/CREATE POLICY\s+\w+\s+ON public\.evidence_events\s+FOR (INSERT|UPDATE|DELETE)/)
    expect(code).toContain('GRANT SELECT ON TABLE public.evidence_events TO authenticated')
  })
})
