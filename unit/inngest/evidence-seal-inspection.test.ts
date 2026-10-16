import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/evidence/seal', () => ({ sealPhoto: vi.fn() }))

import { evidenceSealInspection } from '@/lib/inngest/functions/evidence-seal-inspection'
import { createServiceClient } from '@/lib/supabase/server'
import { sealPhoto } from '@/lib/evidence/seal'
import { invokeHandler } from './test-helpers'

function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'not', 'limit']) c[m] = () => c
  c.maybeSingle = async () => result
  c.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
  return c
}

function stubDb(items: { id: string; photo_path: string | null; answered_at: string | null }[]) {
  const inspection = {
    id: 'i1', org_id: 'o1', property_id: 'p1', completed_by_user_id: 'u1',
    inspector_name: 'Pat', device_clock_offset_seconds: 30,
  }
  vi.mocked(createServiceClient).mockReturnValue({
    from: (table: string) => table === 'inspections'
      ? chain({ data: inspection, error: null })
      : chain({ data: items, error: null }),
  } as never)
}

const step = { run: async (_n: string, cb: () => unknown) => cb() }

describe('evidenceSealInspection', () => {
  beforeEach(() => { vi.mocked(sealPhoto).mockReset(); vi.mocked(sealPhoto).mockResolvedValue({ ok: true, eventId: 'e', duplicate: false, hashVerified: false, bracketed: true }) })

  it('seals once per item with a photo and never for a null photo_path', async () => {
    stubDb([
      { id: 'a', photo_path: 'o1/inspections/a.jpg', answered_at: '2026-10-14T10:00:00Z' },
      { id: 'b', photo_path: null, answered_at: null },
      { id: 'c', photo_path: 'o1/inspections/c.jpg', answered_at: null },
    ])
    const out = await invokeHandler(evidenceSealInspection, { event: { data: { org_id: 'o1', inspection_id: 'i1' } }, step })
    expect(sealPhoto).toHaveBeenCalledTimes(2)
    expect(out).toEqual({ sealed: 2, skipped: 1 })
    const first = vi.mocked(sealPhoto).mock.calls[0][1]
    expect(first.bucket).toBe('inspection-photos')
    expect(first.inspectionId).toBe('i1')
    expect(first.deviceNow).not.toBeNull()
    expect(vi.mocked(sealPhoto).mock.calls[1][1].deviceNow).toBeNull()
  })
})
