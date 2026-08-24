import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// A PM's crew-role correction must survive the nightly Hostex staff sync.
//
// THE DEFECT: Hostex staff records carry no role, so FieldStay INFERS one from
// each person's scheduled task types. That inference was written into
// crew_members unconditionally on every upsert — and the staff sync runs from
// the daily reconcile, not just on connect. A PM who corrected a receptionist
// from General to Cleaning got it reverted the next morning, and every morning
// after. Same class as the property room-count clobber: a value we guessed
// overwriting a value a human set.
//
// The stored role wins unconditionally. An earlier version of this fix
// preserved anything EXCEPT 'general', treating that as "not yet known" so the
// inference could still improve — but 'general' is a role a PM can choose, and
// it is where operators and receptionists land by default, so that carve-out
// re-opened the bug for exactly the people whose role gets corrected.
// ============================================================================

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvents: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/integrations/providers/hostex-api', () => ({
  hostexFetchStaffs: vi.fn(),
  hostexFetchTasks:  vi.fn(),
  hostexTaskWindow:  vi.fn(() => ({ start_date: '2026-05-18', end_date: '2026-08-16' })),
}))

import { syncHostexStaff } from '@/lib/inngest/functions/hostex/staff-sync'
import { createServiceClient } from '@/lib/supabase/server'
import { hostexFetchStaffs, hostexFetchTasks } from '@/lib/integrations/providers/hostex-api'
import type { HostexStaff, HostexTask } from '@/lib/integrations/providers/hostex.types'

/** Runs every step body inline and records the crew_members upsert payload. */
function harness(existingRoles: Array<{ external_id: string; role: string }>) {
  const upserts: Array<Record<string, unknown>[]> = []

  const supabase = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      Object.assign(chain, {
        select: self, eq: self, in: self, order: self, limit: self, range: self, update: self,
        upsert: (rows: Record<string, unknown>[]) => {
          if (table === 'crew_members') upserts.push(rows)
          return Promise.resolve({ error: null })
        },
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: table === 'crew_members' ? existingRoles : [], error: null }),
      })
      return chain
    },
  }
  vi.mocked(createServiceClient).mockReturnValue(supabase as never)

  const step = {
    run: (_id: string, fn: () => unknown) => fn(),
    sendEvent: vi.fn(),
  }

  return { upserts, step }
}

function staff(id: number, name: string): HostexStaff {
  return { id, name, is_active: true }
}

function task(type: HostexTask['type'], staffId: number): HostexTask {
  return { id: staffId * 100, type, status: 'completed', staff_id: staffId }
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

async function run(existingRoles: Array<{ external_id: string; role: string }>) {
  const { upserts, step } = harness(existingRoles)
  await syncHostexStaff({
    step:       step as never,
    logger,
    getToken:   async () => 'tok',
    orgId:      'org_1',
    userId:     'user_1',
    system:     'inngest:test',
    stepPrefix: 'reconcile',
  })
  return upserts[0] ?? []
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(hostexFetchStaffs).mockResolvedValue([staff(1, 'Ana'), staff(2, 'Bo')])
  vi.mocked(hostexFetchTasks).mockResolvedValue([task('reception', 1), task('reception', 2)])
})

describe('Hostex staff sync — crew role preservation', () => {
  it('keeps a role the PM set, instead of re-applying the inferred one nightly', async () => {
    // Both staff infer to 'general' (reception has no crew_role member). The
    // PM has promoted Ana to cleaning.
    const rows = await run([{ external_id: '1', role: 'cleaning' }])

    const byId = Object.fromEntries(rows.map((r) => [r.external_id, r.role]))
    expect(byId['1']).toBe('cleaning')
    expect(byId['2']).toBe('general')
  })

  it("keeps a stored 'general' even when the inference now says otherwise", async () => {
    // The regression this file exists for. 'general' is where every
    // receptionist and operator lands by default, so a PM who reviewed one and
    // left it as General must not have that undone the next morning — and
    // nothing in the row can tell "PM chose General" from "we guessed General".
    vi.mocked(hostexFetchTasks).mockResolvedValue([task('cleaning', 1)])

    const rows = await run([{ external_id: '1', role: 'general' }])

    expect(rows.find((r) => r.external_id === '1')?.role).toBe('general')
  })

  it('preserves a role even when the PM moved it the other way', async () => {
    // Cleaner → General is as much an edit as General → Cleaner.
    vi.mocked(hostexFetchTasks).mockResolvedValue([task('cleaning', 1)])

    const rows = await run([{ external_id: '1', role: 'landscaping' }])

    expect(rows.find((r) => r.external_id === '1')?.role).toBe('landscaping')
  })

  it('still overwrites the fields Hostex actually reports', async () => {
    // Only the role is ours. Name, email, phone and is_active are Hostex's,
    // and a rename there should still land.
    vi.mocked(hostexFetchStaffs).mockResolvedValue([
      { id: 1, name: 'Ana Renamed', email: 'ana@example.com', is_active: true },
    ])

    const rows = await run([{ external_id: '1', role: 'maintenance' }])

    expect(rows[0]).toMatchObject({
      name:  'Ana Renamed',
      email: 'ana@example.com',
      role:  'maintenance',
    })
  })

  it('writes the inferred role for a staff member FieldStay has never seen', async () => {
    vi.mocked(hostexFetchTasks).mockResolvedValue([task('maintenance', 1)])

    const rows = await run([])

    expect(rows.find((r) => r.external_id === '1')?.role).toBe('maintenance')
  })
})
