import { describe, it, expect, vi } from 'vitest'
import { chunkIds, fetchInChunks, IN_CHUNK_SIZE } from '@/lib/dexie/sync/chunked'

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
