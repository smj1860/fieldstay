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
