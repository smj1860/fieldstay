import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/guidebook/helpers', () => ({
  getActiveSponsorCount: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { guidebookGraceExpiredHandler } from '@/lib/inngest/functions/guidebook-grace-expired-handler'
import { createServiceClient } from '@/lib/supabase/server'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.update = (...a: unknown[]) => record('update', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function expiredEvent(overrides: Record<string, unknown> = {}) {
  return { data: { orgId: 'org_1', ...overrides } }
}

describe('guidebookGraceExpiredHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('locks the guidebook when the grace period expires with fewer than 3 active sponsors', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(1)

    const result = await invokeHandler(guidebookGraceExpiredHandler, { event: expiredEvent(), step: makeStep() })

    const update = supabase.calls.find((c) => c.table === 'guidebook_configurations' && c.method === 'update')
    expect(update?.args[0]).toMatchObject({ is_active: false, grace_period_ends_at: null })
    const eqCall = supabase.calls.find((c) => c.table === 'guidebook_configurations' && c.method === 'eq')
    expect(eqCall?.args).toEqual(['org_id', 'org_1'])

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:      'org_1',
        action:     'guidebook.configuration.locked',
        targetType: 'guidebook_configuration',
        metadata:   { activeSponsorCount: 1, reason: 'grace_period_expired' },
      }),
    )
    expect(result).toEqual({ locked: true, orgId: 'org_1', activeSponsorCount: 1 })
  })

  it('clears the grace period without locking when the PM filled the slot in time (>= 3 active sponsors)', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(3)

    const result = await invokeHandler(guidebookGraceExpiredHandler, { event: expiredEvent(), step: makeStep() })

    const update = supabase.calls.find((c) => c.table === 'guidebook_configurations' && c.method === 'update')
    expect(update?.args[0]).toMatchObject({ grace_period_ends_at: null })
    expect(update?.args[0]).not.toHaveProperty('is_active')

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action:   'guidebook.grace_period.cleared',
        metadata: { activeSponsorCount: 3, reason: 'sponsor_replaced' },
      }),
    )
    expect(result).toEqual({ locked: false, reason: 'sponsor_replaced', activeSponsorCount: 3 })
  })

  it('idempotency: re-firing the same expired event twice locks the guidebook both times without erroring', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{ data: null, error: null }, { data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(0)

    const first  = await invokeHandler(guidebookGraceExpiredHandler, { event: expiredEvent(), step: makeStep() })
    const second = await invokeHandler(guidebookGraceExpiredHandler, { event: expiredEvent(), step: makeStep() })

    // Plain UPDATE keyed on org_id — replaying is naturally idempotent:
    // locking an already-locked guidebook is a harmless no-op write.
    expect(first).toEqual(second)
    expect(supabase.calls.filter((c) => c.table === 'guidebook_configurations' && c.method === 'update')).toHaveLength(2)
    expect(logAuditEvent).toHaveBeenCalledTimes(2)
  })
})
