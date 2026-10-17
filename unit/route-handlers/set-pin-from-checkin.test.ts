import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ requireOrgRole: vi.fn(), requireProperty: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/evidence/pin', () => ({ latestPropertyCheckin: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/app/(dashboard)/properties/actions', () => ({ markStepComplete: vi.fn() }))
vi.mock('@/lib/checklists/sync-room-counts', () => ({ syncChecklistRoomCounts: vi.fn() }))

import { setPinFromLastCheckin } from '@/app/(dashboard)/properties/[id]/setup/details/actions'
import { requireOrgRole } from '@/lib/auth'
import { latestPropertyCheckin } from '@/lib/evidence/pin'
import { logAuditEvent } from '@/lib/audit'

function authWith(update: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = []
  const chain: Record<string, unknown> = {}
  for (const m of ['update', 'eq', 'select']) {
    chain[m] = vi.fn((...args: unknown[]) => { calls.push({ method: m, args }); return chain })
  }
  chain.maybeSingle = vi.fn(() => Promise.resolve(update))
  vi.mocked(requireOrgRole).mockResolvedValue({
    user: { id: 'u1' }, membership: { org_id: 'o1' }, supabase: { from: vi.fn(() => chain) },
  } as never)
  return calls
}

const CHECKIN = { id: 'e1', lat: 36.1, lng: -86.7, accuracyFt: 40, capturedAt: '2026-10-10T15:00:00.000Z' }

describe('setPinFromLastCheckin', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses with no check-in, and writes nothing', async () => {
    const calls = authWith({ data: { id: 'p1' }, error: null })
    vi.mocked(latestPropertyCheckin).mockResolvedValue(null)
    const res = await setPinFromLastCheckin('p1')
    expect(res.error).toContain('No crew check-in')
    expect(calls).toHaveLength(0)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('refuses a fix that is not accurate enough', async () => {
    const calls = authWith({ data: { id: 'p1' }, error: null })
    vi.mocked(latestPropertyCheckin).mockResolvedValue({ ...CHECKIN, accuracyFt: 250 })
    expect((await setPinFromLastCheckin('p1')).error).toContain('not accurate enough')
    expect(calls).toHaveLength(0)
  })

  it('moves the pin org-scoped, marks it human-set, and audits it', async () => {
    const calls = authWith({ data: { id: 'p1' }, error: null })
    vi.mocked(latestPropertyCheckin).mockResolvedValue(CHECKIN)
    const res = await setPinFromLastCheckin('p1')
    expect(res).toEqual({ success: true })
    const update = calls.find((c) => c.method === 'update')!.args[0] as Record<string, unknown>
    expect(update).toMatchObject({ lat: 36.1, lng: -86.7 })
    expect(typeof update.location_pinned_at).toBe('string')
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'org_id' && c.args[1] === 'o1')).toBe(true)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'property.pin_set_from_checkin', targetId: 'p1',
      metadata: { pin_source: 'checkin', evidence_event_id: 'e1' },
    }))
  })

  it('reports a write that matched no row (RLS denial) instead of success', async () => {
    authWith({ data: null, error: null })
    vi.mocked(latestPropertyCheckin).mockResolvedValue(CHECKIN)
    expect((await setPinFromLastCheckin('p1')).error).toContain('permission')
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
