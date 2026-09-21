import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/supabase/unwrap', () => ({
  reportQueryError: (error: unknown) => error !== null,
}))

import { loadRemediationIndex } from '@/lib/inspections/remediation'

// ============================================================================
// The "one row per key" assumption (a cancelled WO replaced by a new one, a
// retried request racing a unique constraint, a manually duplicated PO) can
// be violated in real data. Without ORDER BY, Postgres is free to return
// surviving rows in whatever order it finds convenient — not necessarily
// creation order — and the old unconditional Map.set() let whichever row
// happened to come last in the array win. Newest-first + "keep only the
// first row seen per key" makes "newest wins" deterministic.
// ============================================================================

const ORG = 'org-1'

/** A minimal .from().select().eq().in().order().limit() chain that resolves
 *  to whatever rows this test hands it, in the ORDER GIVEN — modelling
 *  Postgres's real newest-first ORDER BY rather than re-sorting for us. */
function makeClient(rowsByTable: Record<string, unknown[]>) {
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
        builder[m] = () => builder
      }
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rowsByTable[table] ?? [], error: null }).then(resolve)
      return builder
    },
  } as unknown as SupabaseClient
  return client
}

describe('loadRemediationIndex — newest-wins dedup', () => {
  it('keeps the FIRST (newest, per the query order) work order when two share a key', async () => {
    const client = makeClient({
      work_orders: [
        // Newest first, as the ORDER BY created_at DESC in the real query
        // guarantees — the cancelled/stale duplicate comes SECOND.
        { wo_number: 'WO-2026-0099', status: 'in_progress', source_inspection_item_id: 'item-1', source_inspection_id: null },
        { wo_number: 'WO-2026-0001', status: 'cancelled',   source_inspection_item_id: 'item-1', source_inspection_id: null },
      ],
      purchase_orders: [],
    })

    const index = await loadRemediationIndex(client, ORG, ['item-1'], ['insp-1'], 'test.site')

    expect(index.byItem.get('item-1')).toEqual({
      kind: 'work_order', reference: 'WO-2026-0099', status: 'in_progress',
    })
  })

  it('keeps the FIRST (newest) inspection-level roll-up work order when two share a key', async () => {
    const client = makeClient({
      work_orders: [
        { wo_number: 'WO-2026-0050', status: 'completed', source_inspection_item_id: null, source_inspection_id: 'insp-1' },
        { wo_number: 'WO-2026-0010', status: 'cancelled',  source_inspection_item_id: null, source_inspection_id: 'insp-1' },
      ],
      purchase_orders: [],
    })

    const index = await loadRemediationIndex(client, ORG, [], ['insp-1'], 'test.site')

    expect(index.byInspection.get('insp-1')).toEqual({
      kind: 'work_order', reference: 'WO-2026-0050', status: 'completed',
    })
  })

  it('a work-order roll-up still wins over a purchase order for the same inspection', async () => {
    const client = makeClient({
      work_orders: [
        { wo_number: 'WO-2026-0050', status: 'completed', source_inspection_item_id: null, source_inspection_id: 'insp-1' },
      ],
      purchase_orders: [
        { id: 'po-1', status: 'ordered', source_inspection_id: 'insp-1' },
      ],
    })

    const index = await loadRemediationIndex(client, ORG, [], ['insp-1'], 'test.site')

    expect(index.byInspection.get('insp-1')).toMatchObject({ kind: 'work_order' })
  })
})
