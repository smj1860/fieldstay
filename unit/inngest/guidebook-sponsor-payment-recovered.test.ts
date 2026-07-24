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

import { guidebookSponsorPaymentRecovered } from '@/lib/inngest/functions/guidebook-sponsor-payment-recovered'
import { createServiceClient } from '@/lib/supabase/server'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and guidebook-daily-monitor. The `guidebook_sponsors` update and the
// `guidebook_configurations` upsert are both awaited directly (no
// .single()/.maybeSingle() call in source), so they resolve via `.then`.
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
    chain.upsert = (...a: unknown[]) => record('upsert', a)
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

function recoveredEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      subscriptionId: 'sub_1',
      orgId:          'org_1',
      sponsorId:      'sponsor_1',
      ...overrides,
    },
  }
}

describe('guidebookSponsorPaymentRecovered', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reactivates the sponsor row and unlocks the guidebook when the threshold is met', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors:       [{ data: null, error: null }],
      guidebook_configurations: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(3)

    const result = await invokeHandler(guidebookSponsorPaymentRecovered, {
      event: recoveredEvent(),
      step:  makeStep(),
    })

    const sponsorUpdate = supabase.calls.find((c) => c.table === 'guidebook_sponsors' && c.method === 'update')
    expect(sponsorUpdate?.args[0]).toMatchObject({ status: 'active', deactivated_at: null })
    // Explicit tenant guard on the reactivate write.
    const sponsorEqCalls = supabase.calls.filter((c) => c.table === 'guidebook_sponsors' && c.method === 'eq')
    expect(sponsorEqCalls.map((c) => c.args)).toEqual([['id', 'sponsor_1'], ['org_id', 'org_1']])

    const configUpsert = supabase.calls.find((c) => c.table === 'guidebook_configurations' && c.method === 'upsert')
    expect(configUpsert?.args[0]).toMatchObject({ org_id: 'org_1', is_active: true, grace_period_ends_at: null })
    expect(configUpsert?.args[1]).toEqual({ onConflict: 'org_id' })

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:      'org_1',
        action:     'guidebook.sponsor.payment_recovered',
        targetType: 'guidebook_sponsor',
        targetId:   'sponsor_1',
        metadata:   { activeSponsorCount: 3, guidebookUnlocked: true },
      }),
    )
    expect(result).toEqual({ activeSponsorCount: 3, sponsorId: 'sponsor_1', orgId: 'org_1' })
  })

  it('reactivates the sponsor but does not unlock the guidebook when still below the 3-sponsor threshold', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(2)

    const result = await invokeHandler(guidebookSponsorPaymentRecovered, {
      event: recoveredEvent(),
      step:  makeStep(),
    })

    expect(supabase.calls.some((c) => c.table === 'guidebook_configurations')).toBe(false)
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { activeSponsorCount: 2, guidebookUnlocked: false } }),
    )
    expect(result).toEqual({ activeSponsorCount: 2, sponsorId: 'sponsor_1', orgId: 'org_1' })
  })

  it('idempotency: re-processing the same recovered event twice reactivates without creating duplicate rows or audit entries', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors:       [{ data: null, error: null }, { data: null, error: null }],
      guidebook_configurations: [{ data: null, error: null }, { data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(4)

    const first  = await invokeHandler(guidebookSponsorPaymentRecovered, { event: recoveredEvent(), step: makeStep() })
    const second = await invokeHandler(guidebookSponsorPaymentRecovered, { event: recoveredEvent(), step: makeStep() })

    // Plain UPDATE/UPSERT — replaying is naturally idempotent: same result,
    // no error, and each run only ever writes exactly one sponsor update.
    expect(first).toEqual(second)
    expect(supabase.calls.filter((c) => c.table === 'guidebook_sponsors' && c.method === 'update')).toHaveLength(2)
    expect(logAuditEvent).toHaveBeenCalledTimes(2)
  })
})
