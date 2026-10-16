import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { chunkArray, IN_CLAUSE_CHUNK_SIZE } from '@/lib/inngest/chunk'

/**
 * Which of these work orders have at least one photo, so a statement only offers
 * "View photos" where there is something to see. The ids come from rows the caller
 * already scoped to one org (owner_transactions), and work_order_photos has no
 * org_id of its own, so this is scoped through that parent set.
 *
 * Each chunk is drained with fetchAllRows (a work order can hold more rows than
 * the page cap across a whole chunk), and the chunks run together.
 */
export async function workOrdersWithPhotos(
  supabase:     SupabaseClient,
  workOrderIds: readonly (string | null)[],
): Promise<Set<string>> {
  const ids = [...new Set(workOrderIds.filter((id): id is string => typeof id === 'string'))]
  const runChunk = (chunk: string[]): Promise<{ work_order_id: string }[]> =>
    fetchAllRows<{ work_order_id: string }>(
      (from, to) => supabase
        .from('work_order_photos')
        .select('id, work_order_id')
        .in('work_order_id', chunk)
        .order('id')
        .range(from, to),
      { label: 'lib.evidence.woPhotoPresence' },
    )
  const results = await Promise.all(chunkArray(ids, IN_CLAUSE_CHUNK_SIZE).map(runChunk))
  return new Set(results.flat().map((r) => r.work_order_id))
}
