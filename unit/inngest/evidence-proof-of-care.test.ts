import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/helpers', () => ({ createPmNotification: vi.fn(async () => undefined) }))

import { evidenceProofOfCare } from '@/lib/inngest/functions/evidence-proof-of-care'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

interface Fixture {
  wo:    { source: string; vendor_id: string | null; needed_by_date: string | null; completed_date: string | null } | null
  seals: { id: string; storage_path: string }[]
  insertError?: { code: string } | null
}

function stub(fx: Fixture) {
  const inserted: Record<string, unknown>[] = []
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'limit']) c[m] = () => c
    c.maybeSingle = async () => result
    c.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
    return c
  }
  vi.mocked(createServiceClient).mockReturnValue({
    from: (table: string) => {
      if (table === 'work_orders') return chain({ data: fx.wo, error: null })
      return {
        select: () => chain({ data: fx.seals, error: null }),
        insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: fx.insertError ?? null } },
      }
    },
  } as never)
  return inserted
}

const run = () => invokeHandler(evidenceProofOfCare, {
  event: { data: { org_id: 'o1', work_order_id: 'w1', property_id: 'p1' } },
  step: { run: async (_n: string, cb: () => unknown) => cb() },
})
const wo = (source = 'freeze_watch') => ({ source, vendor_id: 'v1', needed_by_date: '2026-12-01', completed_date: '2026-12-01' })

describe('evidenceProofOfCare', () => {
  beforeEach(() => vi.mocked(createPmNotification).mockClear())

  it('ignores work orders from any other source', async () => {
    const inserted = stub({ wo: wo('manual'), seals: [] })
    expect(await run()).toEqual({ written: false, reason: 'not_freeze_watch' })
    expect(inserted).toHaveLength(0)
  })

  it('writes no proof row and warns the PM when there are too few sealed photos', async () => {
    const inserted = stub({ wo: wo(), seals: [{ id: 'e1', storage_path: 'a' }] })
    expect(await run()).toMatchObject({ written: false, reason: 'insufficient_photos', count: 1 })
    expect(inserted).toHaveLength(0)
    expect(vi.mocked(createPmNotification).mock.calls[0][1]).toMatchObject({ severity: 'amber' })
  })

  it('writes exactly one proof_of_care row citing the sealed photos', async () => {
    const inserted = stub({ wo: wo(), seals: [{ id: 'e1', storage_path: 'a' }, { id: 'e2', storage_path: 'b' }] })
    expect(await run()).toEqual({ written: true, count: 2 })
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      kind: 'proof_of_care', work_order_id: 'w1', captured_by_kind: 'system',
      metadata: { photo_event_ids: ['e1', 'e2'], photo_count: 2 },
    })
    expect(vi.mocked(createPmNotification).mock.calls[0][1]).toMatchObject({ severity: 'green' })
  })

  it('treats a replayed insert (23505) as already written', async () => {
    stub({ wo: wo(), seals: [{ id: 'e1', storage_path: 'a' }, { id: 'e2', storage_path: 'b' }], insertError: { code: '23505' } })
    expect(await run()).toEqual({ written: false, count: 2 })
  })
})
