import { describe, it, expect, vi } from 'vitest'
import { chunkIds, fetchInChunks, fetchInChunksPaginated, IN_CHUNK_SIZE, fetchAllPages } from '@/lib/dexie/sync/chunked'

describe('chunkIds', () => {
  it('returns an empty array for zero ids', () => {
    expect(chunkIds([])).toEqual([])
  })

  it('returns a single chunk for exactly one id', () => {
    expect(chunkIds(['a'])).toEqual([['a']])
  })

  it('returns a single chunk when ids fit exactly at the boundary (100)', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id_${i}`)
    const chunks = chunkIds(ids)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toHaveLength(100)
  })

  it('splits into two chunks one over the boundary (101)', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id_${i}`)
    const chunks = chunkIds(ids)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(100)
    expect(chunks[1]).toHaveLength(1)
  })

  it('splits 250 ids into three chunks of 100/100/50', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id_${i}`)
    const chunks = chunkIds(ids)
    expect(chunks).toHaveLength(3)
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50])
  })

  it('respects a custom chunk size', () => {
    const ids = Array.from({ length: 5 }, (_, i) => `id_${i}`)
    expect(chunkIds(ids, 2)).toEqual([['id_0', 'id_1'], ['id_2', 'id_3'], ['id_4']])
  })

  it('IN_CHUNK_SIZE is 100', () => {
    expect(IN_CHUNK_SIZE).toBe(100)
  })
})

describe('fetchInChunks', () => {
  it('returns an empty array without calling fetchChunk when ids is empty', async () => {
    const fetchChunk = vi.fn()
    const result = await fetchInChunks([], fetchChunk)
    expect(result).toEqual([])
    expect(fetchChunk).not.toHaveBeenCalled()
  })

  it('concatenates rows across every chunk in order', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i)
    const fetchChunk = vi.fn(async (chunk: number[]) => ({
      data:  chunk.map((id) => ({ id })),
      error: null,
    }))

    const result = await fetchInChunks(ids, fetchChunk)

    expect(fetchChunk).toHaveBeenCalledTimes(3)
    expect(result).toHaveLength(250)
    expect(result?.[0]).toEqual({ id: 0 })
    expect(result?.[249]).toEqual({ id: 249 })
  })

  it('returns null if ANY chunk errors, without partially merging earlier chunks', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i)
    let call = 0
    const fetchChunk = vi.fn(async (chunk: number[]) => {
      call += 1
      if (call === 2) return { data: null, error: { message: 'HTTP 414' } }
      return { data: chunk.map((id) => ({ id })), error: null }
    })

    const result = await fetchInChunks(ids, fetchChunk)

    expect(result).toBeNull()
    // Third chunk is never even attempted once a chunk has failed.
    expect(fetchChunk).toHaveBeenCalledTimes(2)
  })

  it('treats a null data with no error as zero rows for that chunk, not a failure', async () => {
    const fetchChunk = vi.fn(async () => ({ data: null, error: null }))
    const result = await fetchInChunks(['a'], fetchChunk)
    expect(result).toEqual([])
  })
})

describe('fetchInChunksPaginated', () => {
  // The defect this exists for: fetchInChunks bounds the ID LIST, not the ROW
  // COUNT. That is fine when the scope column is the row's own id (100 ids in,
  // <=100 rows out) but checklist_instance_items is scoped by turnover_id, and
  // a turnover's checklist runs 30-60 items. A 100-turnover chunk therefore
  // asks for 3,000-6,000 rows, PostgREST returns the first 1,000 with a 200 and
  // NO truncation signal, and the crew PWA wrote that truncated page into Dexie
  // as though it were the complete checklist — tasks silently missing from a
  // crew member's device, nothing logged, nothing to retry.
  const rows = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => ({ id: `${tag}_${i}` }))

  it('drains a chunk across pages instead of stopping at the 1000-row cap', async () => {
    // One chunk whose scope fans out to 2,300 rows: 1000 + 1000 + 300.
    const pages = [rows(1000, 'a'), rows(1000, 'b'), rows(300, 'c')]
    let call = 0
    const fetchPage = vi.fn(async () => ({ data: pages[call++] ?? [], error: null }))

    const out = await fetchInChunksPaginated(['t1'], fetchPage)

    expect(out).toHaveLength(2300)
    // Three requests: it kept going while pages came back full, and stopped on
    // the first short page rather than looping forever.
    expect(fetchPage).toHaveBeenCalledTimes(3)
  })

  it('passes the right range window for each page', async () => {
    const seen: [number, number][] = []
    let call = 0
    const pages = [rows(1000, 'a'), rows(5, 'b')]
    await fetchInChunksPaginated(['t1'], async (_chunk, from, to) => {
      seen.push([from, to])
      return { data: pages[call++] ?? [], error: null }
    })
    expect(seen).toEqual([[0, 999], [1000, 1999]])
  })

  it('stops immediately on a short first page', async () => {
    const fetchPage = vi.fn(async () => ({ data: rows(3, 'a'), error: null }))
    const out = await fetchInChunksPaginated(['t1'], fetchPage)
    expect(out).toHaveLength(3)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('paginates each chunk independently when the id list spans chunks', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `t_${i}`)   // 2 chunks
    const chunksSeen: number[] = []
    const out = await fetchInChunksPaginated(ids, async (chunk) => {
      chunksSeen.push(chunk.length)
      return { data: rows(10, 'x'), error: null }
    })
    expect(chunksSeen).toEqual([100, 50])
    expect(out).toHaveLength(20)
  })

  it('returns null if any page errors — a partial cache write is the bug', async () => {
    let call = 0
    const out = await fetchInChunksPaginated(['t1'], async () => {
      call++
      if (call === 2) return { data: null, error: { message: 'boom' } }
      return { data: rows(1000, 'a'), error: null }
    })
    expect(out).toBeNull()
  })

  it('returns an empty array for no ids without issuing a request', async () => {
    const fetchPage = vi.fn()
    expect(await fetchInChunksPaginated([], fetchPage)).toEqual([])
    expect(fetchPage).not.toHaveBeenCalled()
  })
})

describe('fetchAllPages', () => {
  // Drains a single filtered read with .range(). Added with the crew
  // assignment-scope fix: there the missing ceiling was not a short list but
  // active deletion — fetchAssignedTurnoverIds returns a crew member's whole
  // assignment scope, and reconcileRemovedTurnovers bulkDeletes every cached
  // turnover absent from it, along with its checklists. Truncated at
  // max_rows = 1000, a cleaner past ~1000 lifetime assignments would have
  // their device erase turnovers that were still genuinely assigned.

  /** Serves `total` rows through .range()-style paging. */
  function pager(total: number) {
    const pages: number[] = []
    return {
      pages,
      fetchPage: (from: number, to: number) => {
        const slice = Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) },
          (_, i) => ({ id: `r${from + i}` }))
        pages.push(slice.length)
        return Promise.resolve({ data: slice, error: null })
      },
    }
  }

  it('returns EVERY row past the 1000-row page cap', async () => {
    const { fetchPage, pages } = pager(2_500)
    const rows = await fetchAllPages<{ id: string }>(fetchPage)
    expect(rows).toHaveLength(2_500)
    expect(rows![0].id).toBe('r0')
    expect(rows![2_499].id).toBe('r2499')      // the row a single read lost
    expect(pages).toEqual([1000, 1000, 500])   // stops on the short page
  })

  it('makes exactly one request when the first page is short', async () => {
    const { fetchPage, pages } = pager(12)
    await expect(fetchAllPages<{ id: string }>(fetchPage)).resolves.toHaveLength(12)
    expect(pages).toEqual([12])
  })

  it('stops after one request for an empty result', async () => {
    const { fetchPage, pages } = pager(0)
    await expect(fetchAllPages<{ id: string }>(fetchPage)).resolves.toEqual([])
    expect(pages).toEqual([0])
  })

  it('returns null on error rather than a partial set', async () => {
    // A partial assignment scope is worse than none: the caller would treat
    // every missing turnover as unassigned and delete it. Null makes the
    // caller bail instead.
    let call = 0
    const rows = await fetchAllPages<{ id: string }>(() => {
      call++
      if (call === 2) return Promise.resolve({ data: null, error: { message: 'boom' } })
      return Promise.resolve({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}` })), error: null })
    })
    expect(rows).toBeNull()
  })

  it('does not loop forever when a full page repeats', async () => {
    // Defensive: a page that never shortens would spin. Bounded by asserting
    // the helper advances `from` — a mock ignoring range would repeat.
    const seen: number[] = []
    const rows = await fetchAllPages<{ id: string }>((from) => {
      seen.push(from)
      if (seen.length > 5) return Promise.resolve({ data: [], error: null })
      return Promise.resolve({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `r${from + i}` })), error: null })
    })
    expect(rows).not.toBeNull()
    expect(seen).toEqual([0, 1000, 2000, 3000, 4000, 5000])
  })
})
