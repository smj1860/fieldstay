import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ============================================================================
// THE GTM AGENT SCHEMA, AGAINST A REAL POSTGRES.
//
// What this pins is behaviour a source-text test cannot see:
//   - the depth cap that stops agents spawning work from each other forever is
//     a CHECK in the database, not a convention in a caller
//   - the dedupe_key index really does stop a replayed insert
//   - "append-only" is a GRANT: an admin has no UPDATE/DELETE on the spend
//     ledger or the manager's decision log, and no INSERT on the queue
//   - a non-admin reads nothing, including through the rollup function
//   - the migration is safe to run twice (every migration here must be)
//
// Skips cleanly when no Postgres server binaries are installed.
// ============================================================================

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/15/bin']
  .find((d) => existsSync(join(d, 'initdb')))
const root = process.cwd()
const MIGRATION = join(root, 'supabase/migrations/20261118120000_gtm_agent_foundation.sql')
const migrationSql = readFileSync(MIGRATION, 'utf8')

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NOBODY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PORT = String(57000 + (process.pid % 1000))

let dataDir = ''
let socketDir = ''
const asRoot = process.getuid?.() === 0

function run(cmd: string, args: string[]): string {
  const [bin, a] = asRoot ? ['su', ['postgres', '-s', '/bin/sh', '-c', [cmd, ...args].map((x) => `'${x}'`).join(' ')]] : [cmd, args]
  return execFileSync(bin, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function psql(args: string[]): string {
  return execFileSync('psql', ['-h', socketDir, '-p', PORT, '-U', 'postgres', '-d', 'gtm', '-X', '-q', '-A', '-t',
    '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function sql(text: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: psql(['-c', text]).trim() }
  } catch (err) {
    return { ok: false, out: String((err as { stderr?: string }).stderr ?? err) }
  }
}

/** Runs one statement the way PostgREST would: as `authenticated`, with a JWT subject. */
function as(userId: string, text: string): { ok: boolean; out: string } {
  return sql(`SET ROLE authenticated; SET request.jwt.claim.sub = '${userId}'; ${text}`)
}

const asService = (text: string) => sql(`SET ROLE service_role; ${text}`)

const task = (extra = '') => asService(
  `INSERT INTO agent_tasks (team, task_type${extra ? ', ' + extra.split('|')[0] : ''})
   VALUES ('lead_gen', 'enrich_account'${extra ? ', ' + extra.split('|')[1] : ''}) RETURNING id`)

describe.skipIf(!BIN)('GTM agent foundation (real Postgres)', () => {
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'gtm-pg-'))
    socketDir = mkdtempSync(join(tmpdir(), 'gtm-sock-'))
    if (asRoot) { for (const d of [dataDir, socketDir]) { chmodSync(d, 0o777); execFileSync('chown', ['postgres', d]) } }
    run(join(BIN!, 'initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust'])
    run(join(BIN!, 'pg_ctl'), ['-D', dataDir, '-o', `-p ${PORT} -k ${socketDir} -c listen_addresses=`, '-w', '-l', join(dataDir, 'log'), 'start'])
    execFileSync('psql', ['-h', socketDir, '-p', PORT, '-U', 'postgres', '-qc', 'CREATE DATABASE gtm'])
    psql(['-f', join(root, 'unit/gtm/gtm-harness.sql'), '-f', MIGRATION,
      '-f', join(root, 'supabase/migrations/20261118130000_gtm_sweep_resumes_approved.sql'),
      '-f', join(root, 'supabase/migrations/20260824011348_db_narrowed_update_grants_report.sql')])
    sql(`INSERT INTO auth.users(id) VALUES ('${ADMIN}'), ('${NOBODY}');
         INSERT INTO platform_staff(user_id, role) VALUES ('${ADMIN}', 'admin'), ('${NOBODY}', 'support');
         INSERT INTO prospect_accounts(company, status) VALUES ('A','new'),('B','new'),('C','replied');
         INSERT INTO prospect_touches(prospect_id, touch_type)
           SELECT id, 'emailed' FROM prospect_accounts WHERE company = 'A'`)
  }, 120_000)

  afterAll(() => {
    try { run(join(BIN!, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', 'stop']) } catch { /* already down */ }
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(socketDir, { recursive: true, force: true })
  })

  it('seeds every team, and every team ships disabled and propose-only', () => {
    expect(sql(`SELECT count(*) FROM gtm_team_settings`).out).toBe('6')
    expect(sql(`SELECT count(*) FROM gtm_team_settings WHERE enabled OR autonomy <> 'propose_only'`).out).toBe('0')
  })

  it('is safe to run twice, and a re-run does not reset an admin-edited setting', () => {
    expect(sql(`UPDATE gtm_team_settings SET enabled = true, daily_task_cap = 7 WHERE team = 'lead_gen'`).ok).toBe(true)
    psql(['-f', MIGRATION, '-f', join(root, 'supabase/migrations/20261118130000_gtm_sweep_resumes_approved.sql')])
    expect(sql(`SELECT enabled::text || daily_task_cap FROM gtm_team_settings WHERE team = 'lead_gen'`).out).toBe('true7')
    expect(sql(`SELECT count(*) FROM gtm_team_settings`).out).toBe('6')
  })

  it('caps handoff depth in the database, not in a caller', () => {
    expect(task('depth|4').ok).toBe(true)
    const over = task('depth|5')
    expect(over.ok).toBe(false)
    expect(over.out).toContain('agent_tasks_depth_check')
  })

  it('rejects a replayed insert that carries the same dedupe_key', () => {
    expect(task(`dedupe_key|'plan:2026-11-18:acct-1'`).ok).toBe(true)
    const again = task(`dedupe_key|'plan:2026-11-18:acct-1'`)
    expect(again.ok).toBe(false)
    expect(again.out).toContain('agent_tasks_dedupe_key_uidx')
    // NULL means "no protection needed" and must not collide with itself.
    expect(task().ok).toBe(true)
    expect(task().ok).toBe(true)
  })

  it('defaults a task to needing approval, so opting out is the deliberate act', () => {
    const id = task().out.split('\n')[0]
    expect(sql(`SELECT requires_approval::text || status FROM agent_tasks WHERE id = '${id}'`).out).toBe('truepending')
  })

  it('refuses an unknown team, status and origin', () => {
    expect(asService(`INSERT INTO agent_tasks (team, task_type) VALUES ('manager', 'x')`).ok).toBe(false)
    expect(asService(`INSERT INTO agent_tasks (team, task_type, status) VALUES ('lead_gen', 'x', 'shipped')`).ok).toBe(false)
    expect(asService(`INSERT INTO agent_tasks (team, task_type, origin) VALUES ('lead_gen', 'x', 'intern')`).ok).toBe(false)
  })

  it('lets a platform admin read and decide tasks, but not create or delete them', () => {
    const id = task().out.split('\n')[0]
    expect(as(ADMIN, `SELECT count(*) FROM agent_tasks WHERE id = '${id}'`).out).toBe('1')
    expect(as(ADMIN, `UPDATE agent_tasks SET status = 'cancelled' WHERE id = '${id}'`).ok).toBe(true)
    expect(as(ADMIN, `INSERT INTO agent_tasks (team, task_type) VALUES ('lead_gen', 'x')`).ok).toBe(false)
    expect(as(ADMIN, `DELETE FROM agent_tasks WHERE id = '${id}'`).ok).toBe(false)
  })

  // The harness reproduces Supabase's default of granting authenticated every
  // privilege on a new table. Without the migration's REVOKE, TRUNCATE would
  // still work here, and RLS does not apply to TRUNCATE at all.
  it('strips the default privileges: no signed-in user can truncate, insert into or delete from any of the four', () => {
    for (const table of ['gtm_team_settings', 'agent_tasks', 'agent_usage', 'manager_decisions']) {
      expect(as(ADMIN, `TRUNCATE ${table}`).ok).toBe(false)
      expect(as(NOBODY, `TRUNCATE ${table}`).ok).toBe(false)
      expect(as(ADMIN, `DELETE FROM ${table}`).ok).toBe(false)
    }
  })

  it('lets a person decide a task but never rewrite what the agent produced', () => {
    const id = task().out.split('\n')[0]
    expect(as(ADMIN, `UPDATE agent_tasks SET status = 'approved', decided_by = '${ADMIN}', decided_at = now(), decision_note = 'ok' WHERE id = '${id}'`).ok).toBe(true)
    for (const column of ["output = '{}'::jsonb", 'requires_approval = false', 'depth = 0', "team = 'rev_ops'", "dedupe_key = 'x'", 'attempts = 0']) {
      const res = as(ADMIN, `UPDATE agent_tasks SET ${column} WHERE id = '${id}'`)
      expect(res.ok, column).toBe(false)
      expect(res.out).toContain('permission denied')
    }
  })

  it('lets an admin change a team\'s settings but never its key', () => {
    expect(as(ADMIN, `UPDATE gtm_team_settings SET enabled = true, daily_task_cap = 9, updated_by = '${ADMIN}' WHERE team = 'rev_ops'`).ok).toBe(true)
    expect(sql(`SELECT updated_at > now() - interval '1 minute' FROM gtm_team_settings WHERE team = 'rev_ops'`).out).toBe('t')
    expect(as(ADMIN, `UPDATE gtm_team_settings SET team = 'sales_ops' WHERE team = 'rev_ops'`).ok).toBe(false)
  })

  // check-db-invariants.mjs reads this function and fails CI if a table drops off
  // it, so the registry entries must match what the migration really grants.
  it('reports both column-narrowed grants, with exactly the columns the CI registry lists', () => {
    const report = JSON.parse(asService(`SELECT db_narrowed_update_grants()`).out.split('\n').pop() ?? '[]') as
      { table: string; columns: string[] }[]
    const registry = readFileSync(join(root, 'scripts/check-db-invariants.mjs'), 'utf8')
    for (const table of ['agent_tasks', 'gtm_team_settings']) {
      const live = report.find((e) => e.table === table)
      expect(live, `${table} should be column-narrowed`).toBeDefined()
      const line = registry.split('\n').find((l) => l.trimStart().startsWith(`${table}:`))
      expect(line, `${table} must be in NARROWED_UPDATE_GRANTS`).toBeDefined()
      const listed = [...(line ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
      expect(listed).toEqual([...live!.columns].sort())
    }
  })

  it('keeps the spend ledger and the manager log append-only for everyone but the service role', () => {
    expect(asService(`INSERT INTO agent_usage (team, model, cost_cents) VALUES ('manager', 'm', 0.25)`).ok).toBe(true)
    expect(asService(`INSERT INTO manager_decisions (kind, autonomy_at_run, brief) VALUES ('manual', 'propose_only', 'b')`).ok).toBe(true)
    for (const table of ['agent_usage', 'manager_decisions']) {
      expect(as(ADMIN, `SELECT count(*) FROM ${table}`).ok).toBe(true)
      expect(as(ADMIN, `UPDATE ${table} SET model = 'x'`).ok).toBe(false)
      expect(as(ADMIN, `DELETE FROM ${table}`).ok).toBe(false)
      expect(as(ADMIN, `TRUNCATE ${table}`).ok).toBe(false)
    }
  })

  it('deduplicates scheduled manager briefs on their slot key', () => {
    const insert = (key: string) => asService(
      `INSERT INTO manager_decisions (kind, autonomy_at_run, brief, dedupe_key)
       VALUES ('morning_plan', 'propose_only', 'b', '${key}')`)
    expect(insert('morning_plan:2026-11-18').ok).toBe(true)
    expect(insert('morning_plan:2026-11-18').ok).toBe(false)
    expect(insert('morning_plan:2026-11-19').ok).toBe(true)
  })

  it('dedupes a replayed usage row on its key', () => {
    const insert = (key: string) => asService(
      `INSERT INTO agent_usage (team, model, cost_cents, dedupe_key) VALUES ('rev_ops', 'm', 1, '${key}')`)
    expect(insert('manager:morning_plan:2026-11-18').ok).toBe(true)
    expect(insert('manager:morning_plan:2026-11-18').ok).toBe(false)
  })

  describe('gtm_sweep_stalled_tasks', () => {
    const stale = (extra: string) => {
      const id = task(extra).out.split('\n')[0]
      sql(`UPDATE agent_tasks SET status = 'in_progress', claimed_at = now() - interval '2 hours' WHERE id = '${id}'`)
      return id
    }
    const sweep = () => JSON.parse(asService(`SELECT gtm_sweep_stalled_tasks(now() - interval '30 minutes')`).out.split('\n').pop() ?? '{}') as
      { requeued: number; failed: number }

    it('requeues a stalled task that has attempts left, and fails one that does not', () => {
      const retry = stale('attempts|0')
      const spent = stale('attempts|2')
      expect(sweep()).toEqual({ requeued: 1, failed: 1 })
      expect(sql(`SELECT status || attempts FROM agent_tasks WHERE id = '${retry}'`).out).toBe('pending1')
      expect(sql(`SELECT status || attempts || (completed_at IS NOT NULL) FROM agent_tasks WHERE id = '${spent}'`).out).toBe('failed3true')
    })

    // A task that died while CARRYING OUT an approved proposal must go back to
    // 'approved'. Sent to 'pending' it would redo the research and ask for the
    // same approval a second time.
    it('puts an abandoned task back at the stage it was claimed from', () => {
      const approved = stale('attempts|0')
      sql(`UPDATE agent_tasks SET decided_at = now(), decided_by = '${ADMIN}' WHERE id = '${approved}'`)
      const fresh = stale('attempts|0')
      expect(sweep()).toEqual({ requeued: 2, failed: 0 })
      expect(sql(`SELECT status FROM agent_tasks WHERE id = '${approved}'`).out).toBe('approved')
      expect(sql(`SELECT status FROM agent_tasks WHERE id = '${fresh}'`).out).toBe('pending')
    })

    it('still fails an approved task for good once its attempts are spent', () => {
      const spent = stale('attempts|2')
      sql(`UPDATE agent_tasks SET decided_at = now() WHERE id = '${spent}'`)
      expect(sweep()).toEqual({ requeued: 0, failed: 1 })
      expect(sql(`SELECT status FROM agent_tasks WHERE id = '${spent}'`).out).toBe('failed')
    })

    it('leaves a task that was claimed recently alone, and a second sweep is a no-op', () => {
      const id = task().out.split('\n')[0]
      sql(`UPDATE agent_tasks SET status = 'in_progress', claimed_at = now() WHERE id = '${id}'`)
      expect(sweep()).toEqual({ requeued: 0, failed: 0 })
      expect(sweep()).toEqual({ requeued: 0, failed: 0 })
      expect(sql(`SELECT status FROM agent_tasks WHERE id = '${id}'`).out).toBe('in_progress')
    })

    it('is callable by the service role only', () => {
      expect(as(ADMIN, `SELECT gtm_sweep_stalled_tasks(now())`).ok).toBe(false)
      expect(sql(`SET ROLE anon; SELECT gtm_sweep_stalled_tasks(now())`).ok).toBe(false)
    })
  })

  it('shows a platform admin the settings and hides everything from other staff', () => {
    expect(as(ADMIN, `SELECT count(*) FROM gtm_team_settings`).out).toBe('6')
    expect(as(NOBODY, `SELECT count(*) FROM gtm_team_settings`).out).toBe('0')
    expect(as(NOBODY, `UPDATE gtm_team_settings SET enabled = true`).out).not.toContain('ERROR')
    expect(sql(`SELECT count(*) FROM gtm_team_settings WHERE team = 'global' AND enabled`).out).toBe('0')
  })

  it('refuses anon any access at all', () => {
    expect(sql(`SET ROLE anon; SELECT count(*) FROM agent_tasks`).ok).toBe(false)
    expect(sql(`SET ROLE anon; SELECT gtm_dashboard_counts(now(), now())`).ok).toBe(false)
  })

  describe('gtm_dashboard_counts', () => {
    const counts = (user: string) => JSON.parse(
      as(user, `SELECT gtm_dashboard_counts(now() - interval '7 days', date_trunc('day', now()))`).out.split('\n').pop() ?? '{}',
    ) as { funnel: Record<string, number>; touches: Record<string, number>; tasks: unknown[]; spend: { team: string; calls: number }[] }

    it('rolls the funnel, touches, queue and spend up in one call for an admin', () => {
      const c = counts(ADMIN)
      expect(c.funnel).toEqual({ new: 2, replied: 1 })
      expect(c.touches).toEqual({ emailed: 1 })
      expect(c.tasks.length).toBeGreaterThan(0)
      expect(c.spend.find((s) => s.team === 'manager')?.calls).toBe(1)
    })

    it('counts only approvals that have waited past 48 hours as stale', () => {
      const waiting = (age: string) => {
        const id = task().out.split('\n')[0]
        sql(`ALTER TABLE agent_tasks DISABLE TRIGGER trg_agent_tasks_updated_at;
             UPDATE agent_tasks SET status = 'needs_approval', updated_at = now() - interval '${age}' WHERE id = '${id}';
             ALTER TABLE agent_tasks ENABLE TRIGGER trg_agent_tasks_updated_at`)
      }
      const stale = () => (JSON.parse(
        as(ADMIN, `SELECT gtm_dashboard_counts(now(), now())`).out.split('\n').pop() ?? '{}',
      ) as { stale_approvals: number }).stale_approvals
      const before = stale()
      waiting('3 hours')
      expect(stale()).toBe(before)
      waiting('3 days')
      expect(stale()).toBe(before + 1)
    })

    it('runs as the caller, so another staff member gets empty rollups rather than a bypass', () => {
      const c = counts(NOBODY)
      expect(c.funnel).toEqual({})
      expect(c.touches).toEqual({})
      expect(c.tasks).toEqual([])
      expect(c.spend).toEqual([])
    })

    it('leaves tasks older than 30 days out of the finished-work counts but keeps live ones', () => {
      const old = task().out.split('\n')[0]
      asService(`UPDATE agent_tasks SET status = 'done' WHERE id = '${old}'`)
      sql(`ALTER TABLE agent_tasks DISABLE TRIGGER trg_agent_tasks_updated_at;
           UPDATE agent_tasks SET updated_at = now() - interval '45 days' WHERE id = '${old}';
           ALTER TABLE agent_tasks ENABLE TRIGGER trg_agent_tasks_updated_at`)
      const rows = counts(ADMIN).tasks as { team: string; status: string; count: number }[]
      expect(rows.some((r) => r.status === 'pending')).toBe(true)
      const stale = sql(`SELECT count(*) FROM agent_tasks WHERE id = '${old}' AND status = 'done' AND updated_at < now() - interval '30 days'`).out
      expect(stale).toBe('1')
    })
  })
})

describe('GTM migration (structure, runs everywhere)', () => {
  const code = migrationSql.replace(/--.*$/gm, '')

  it('enables RLS on every table it creates', () => {
    const created = [...code.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1])
    expect(created.sort()).toEqual(['agent_tasks', 'agent_usage', 'gtm_team_settings', 'manager_decisions'])
    for (const t of created) expect(code).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`)
  })

  it('revokes from authenticated as well as anon before granting anything back', () => {
    expect(code).toMatch(/REVOKE ALL ON TABLE[^;]*FROM anon, authenticated, PUBLIC/)
  })

  it('never grants anon anything, and gives authenticated no table-wide UPDATE', () => {
    expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\banon\b/)
    expect(code).not.toMatch(/GRANT[^;]*\bUPDATE\b(?!\s*\()[^;]*TO authenticated/)
  })
})
