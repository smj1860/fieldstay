/**
 * Splits an array into fixed-size chunks — for bounding CONCURRENCY on
 * outbound calls inside a single Inngest step, as distinct from
 * lib/inngest/paginate.ts, which bounds ROWS READ from Supabase via
 * `.range()`.
 *
 * A step that fans out N outbound calls with a single `Promise.all(items.map(...))`
 * opens all N at once — fine for a handful, but at real portfolio scale (a
 * 150-property org, one Tomorrow.io lookup per distinct property location)
 * that is 150 simultaneous connections to a rate-limited third party from one
 * process. Chunking the array and awaiting one `Promise.all()` per chunk caps
 * how many calls are ever in flight together while still running each
 * chunk's calls in parallel rather than sequentially.
 */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunkArray: size must be >= 1, got ${size}`)
  if (!items.length) return []

  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}
