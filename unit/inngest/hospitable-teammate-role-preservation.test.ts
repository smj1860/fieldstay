import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// A PM's crew-role correction must survive the nightly Hospitable teammate sync.
//
// THE DEFECT, and it was live in production until 2026-08-27: Hospitable
// teammates carry service LABELS, not a FieldStay role, so
// mapHospitableTeammateRole() infers one. That inference was written into
// crew_members on every upsert, and hospTeammateSyncCron runs the handler once
// daily per connection — so a PM who corrected someone in crew-manage got it
// reverted by morning, every morning, with no error anywhere. The write
// succeeded, the UI showed the new role, and the cron quietly undid it.
//
// This is the SAME defect Hostex hit and fixed on 2026-08-17. Hospitable had
// the identical payload shape and never got the fix, because the fix lived
// inside hostex/staff-sync.ts instead of somewhere both could reach. It is now
// shared/preserve-crew-roles.ts, and this file is the Hospitable half of the
// coverage that should have existed then.
//
// The stored role wins unconditionally, INCLUDING 'general' — see the helper
// for why the "treat general as unset" carve-out re-opens the bug for exactly
// the people whose role gets corrected.
//
// hospitableTeammatesToCrewRows and mapHospitableTeammateRole are deliberately
// NOT mocked: the whole question is whether a REAL inference gets overridden by
// a stored value, and a stubbed mapper would let this pass while the real one
// clobbers.
// ============================================================================

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvents: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/integrations/providers/hospitable-token', () => ({
  getValidHospitableToken: vi.fn(async () => 'tok'),
}))
vi.mock('@/lib/integrations/providers/hospitable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/integrations/providers/hospitable')>()),
  hospFetchTeammates: vi.fn(),
}))

import { hospTeammateSyncHandler } from '@/lib/inngest/functions/hospitable/teammate-sync-handler'
import { createServiceClient } from '@/lib/supabase/server'
import { hospFetchTeammates } from '@/lib/integrations/providers/hospitable'
import { invokeHandler } from './test-helpers'

type StoredRole = { external_id: string; role: string }

/** Runs every step body inline and captures the crew_members upsert payload. */
function harness(existingRoles: StoredRole[]) {
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
        // Serves BOTH crew_members reads: the preservation lookup and the
        // deactivation pass's active-roster read. The latter is harmless here —
        // these rows carry no `id`, and every external_id is in the fresh set,
        // so nothing is selected for deactivation.
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: table === 'crew_members' ? existingRoles : [], error: null }),
      })
      return chain
    },
  }
  vi.mocked(createServiceClient).mockReturnValue(supabase as never)

  return { upserts }
}

const runAllStep = () => ({
  run: (_id: string, fn: () => unknown) => fn(),
  sendEvent: vi.fn(),
})

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

async function run(existingRoles: StoredRole[]) {
  const { upserts } = harness(existingRoles)
  await invokeHandler(hospTeammateSyncHandler, {
    event:  { data: { user_id: 'user_1', org_id: 'org_1', external_user_id: 'ext_1' } },
    step:   runAllStep(),
    logger,
  })
  return upserts[0] ?? []
}

beforeEach(() => {
  vi.clearAllMocks()
  // Real inference on these labels yields 'cleaning'.
  vi.mocked(hospFetchTeammates).mockResolvedValue([
    { id: 'tm_1', name: 'Ana Cleaner', services: [{ label: 'Cleaning' }] },
  ] as never)
})

describe('Hospitable teammate sync — crew role preservation', () => {
  it('keeps a role the PM set, instead of re-applying the inferred one nightly', async () => {
    const rows = await run([{ external_id: 'tm_1', role: 'maintenance' }])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('maintenance')
  })

  it("keeps a stored 'general' even when the inference now says otherwise", async () => {
    // The carve-out that re-opened this bug on the Hostex side. 'general' is a
    // role a PM can deliberately choose, and nothing on the row distinguishes
    // "reviewed and left General" from "guessed General last night".
    const rows = await run([{ external_id: 'tm_1', role: 'general' }])
    expect(rows[0]!.role).toBe('general')
  })

  it('writes the inferred role for a teammate FieldStay has never seen', async () => {
    // The control. Without this the three assertions above would pass against a
    // handler that hardcoded a role, or one that never wrote a role at all.
    const rows = await run([])
    expect(rows[0]!.role).toBe('cleaning')
  })

  it('still overwrites the fields Hospitable actually reports', async () => {
    // Preservation is scoped to `role` alone. Name and specialty come from
    // Hospitable and SHOULD be refreshed nightly — a fix that froze the whole
    // row would be a different bug wearing the same green tick.
    const rows = await run([{ external_id: 'tm_1', role: 'maintenance' }])
    expect(rows[0]!.name).toBe('Ana Cleaner')
    expect(rows[0]!.specialty).toBe('Cleaning')
  })
})
