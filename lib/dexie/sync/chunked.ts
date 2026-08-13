// lib/dexie/sync/chunked.ts
//
// PostgREST encodes .in() values into the query string, so an unbounded id
// array eventually produces a URL past the gateway's limit and returns 414.
// The crew sync's error path is console.error + return, so that failure is
// SILENT — a partially-populated cache with no user-visible signal. Every
// .in() in the sync layer routes through here instead.
//
// 100 UUIDs ≈ 3.7KB of query string, comfortably inside every proxy default
// while keeping round trips low for realistic assignment counts.
export const IN_CHUNK_SIZE = 100

export function chunkIds<T>(ids: readonly T[], size: number = IN_CHUNK_SIZE): T[][] {
  if (ids.length <= size) return ids.length ? [ids as T[]] : []
  const out: T[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size) as T[])
  return out
}

/**
 * Runs `fetchChunk` over id chunks and concatenates the results.
 * Returns null if ANY chunk fails — callers already treat null as
 * "abort this sync pass", and a partial merge would silently write an
 * incomplete cache, which is the exact failure this module prevents.
 */
export async function fetchInChunks<TId, TRow>(
  ids:        readonly TId[],
  fetchChunk: (chunk: TId[]) => Promise<{ data: TRow[] | null; error: unknown }>,
): Promise<TRow[] | null> {
  const rows: TRow[] = []
  for (const chunk of chunkIds(ids)) {
    const { data, error } = await fetchChunk(chunk)
    if (error) return null
    rows.push(...(data ?? []))
  }
  return rows
}

/** PostgREST's max_rows cap (supabase/config.toml). See fetchInChunksPaginated. */
const SUPABASE_MAX_ROWS = 1000

/**
 * fetchInChunks for a ONE-TO-MANY scope, where chunking the id list does NOT
 * bound the row count.
 *
 * fetchInChunks is safe when the scope column is the row's own id: 100 ids in,
 * at most 100 rows out. It is NOT safe when one scoped id maps to many rows.
 * checklist_instance_items is queried by `turnover_id`, and a turnover's
 * checklist runs 30–60 items — so a 100-turnover chunk asks for 3,000–6,000
 * rows and PostgREST returns the first 1,000 with a 200 and no truncation
 * signal. The crew PWA then wrote that truncated page into Dexie as if it were
 * the whole checklist: tasks silently missing from a crew member's device,
 * with nothing logged and no error to retry.
 *
 * Each chunk is drained by `.range()` until a short page arrives, so the row
 * count no longer has a ceiling — only the id list is chunked, and only to
 * keep the query string under the gateway's URL limit.
 */
export async function fetchInChunksPaginated<TId, TRow>(
  ids:       readonly TId[],
  fetchPage: (chunk: TId[], from: number, to: number) => Promise<{ data: TRow[] | null; error: unknown }>,
): Promise<TRow[] | null> {
  const rows: TRow[] = []
  for (const chunk of chunkIds(ids)) {
    for (let from = 0; ; from += SUPABASE_MAX_ROWS) {
      const { data, error } = await fetchPage(chunk, from, from + SUPABASE_MAX_ROWS - 1)
      if (error) return null
      const page = data ?? []
      rows.push(...page)
      if (page.length < SUPABASE_MAX_ROWS) break
    }
  }
  return rows
}

/**
 * Drain a single filtered read to completion with `.range()`.
 *
 * The sibling above chunks an ID LIST; this one has no list to chunk — it is
 * for a plain `.eq(parent_id, …)` read whose row count has no ceiling.
 *
 * Added 2026-08-12 for fetchAssignedTurnoverIds, where the missing ceiling was
 * not a short list but active deletion: that function returns a crew member's
 * whole assignment scope, and reconcileRemovedTurnovers bulkDeletes every
 * cached turnover NOT in it, along with its checklists. Truncated at
 * max_rows = 1000, a long-tenured cleaner's device would start erasing
 * turnovers that were still genuinely assigned — and, with no ORDER BY, a
 * different arbitrary 1000 each sync, so it would thrash rather than settle.
 */
export async function fetchAllPages<TRow>(
  fetchPage: (from: number, to: number) => Promise<{ data: TRow[] | null; error: unknown }>,
): Promise<TRow[] | null> {
  const rows: TRow[] = []
  for (let from = 0; ; from += SUPABASE_MAX_ROWS) {
    const { data, error } = await fetchPage(from, from + SUPABASE_MAX_ROWS - 1)
    if (error) return null
    const page = data ?? []
    rows.push(...page)
    if (page.length < SUPABASE_MAX_ROWS) break
  }
  return rows
}
