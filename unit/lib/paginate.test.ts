import { describe, it, expect, vi } from 'vitest'
import { fetchAllRows, foldAllRows, SUPABASE_MAX_ROWS } from '@/lib/inngest/paginate'

// ============================================================================
// lib/inngest/paginate.ts had no direct tests at all — every assertion about it
// lived inside a cron's test as a side effect of that cron's fixtures. It is
// the single helper standing between every platform-wide scan and PostgREST's
// silent 1000-row truncation, and fetchAllRows now delegates to foldAllRows,
// so both need to be pinned on their own.
// ============================================================================

/** A fake PostgREST endpoint over `total` rows, honouring .range(from, to). */
function pagedSource(total: number) {
  const calls: [number, number][] = []
  const fetchPage = vi.fn(async (from: number, to: number) => {
    calls.push([from, to])
    const rows = []
    for (let i = from; i <= Math.min(to, total - 1); i++) rows.push({ i })
    return { data: rows, error: null }
  })
  return { fetchPage, calls }
}

describe('fetchAllRows', () => {
  it('walks every page until a short one arrives', async () => {
    const { fetchPage, calls } = pagedSource(2_100)
    const rows = await fetchAllRows<{ i: number }>(fetchPage)

    expect(rows).toHaveLength(2_100)
    expect(rows[0]!.i).toBe(0)
    expect(rows[2_099]!.i).toBe(2_099)
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('stops after one request when the first page is short', async () => {
    const { fetchPage, calls } = pagedSource(3)
    expect(await fetchAllRows(fetchPage)).toHaveLength(3)
    expect(calls).toHaveLength(1)
  })

  it('makes a SECOND request when the row count lands exactly on the page size', async () => {
    // The terminator is "a short page", so an exactly-full page is
    // indistinguishable from a truncated one and must be followed up. Getting
    // this wrong is the same silent-truncation bug the helper exists to stop,
    // just moved one layer up.
    const { fetchPage, calls } = pagedSource(SUPABASE_MAX_ROWS)
    expect(await fetchAllRows(fetchPage)).toHaveLength(SUPABASE_MAX_ROWS)
    expect(calls).toEqual([[0, 999], [1000, 1999]])
  })

  it('throws on a query error rather than returning a short list', async () => {
    const fetchPage = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))
    await expect(fetchAllRows(fetchPage, { label: 'widgets' })).rejects.toThrow(/Paginated fetch failed \(widgets\): boom/)
  })

  it('throws at maxRows instead of silently truncating', async () => {
    const { fetchPage } = pagedSource(10_000)
    await expect(fetchAllRows(fetchPage, { maxRows: 2_000, label: 'widgets' }))
      .rejects.toThrow(/exceeded maxRows.*widgets/)
  })
})

describe('foldAllRows', () => {
  it('produces the same total as accumulating, without holding the rows', async () => {
    const { fetchPage } = pagedSource(2_100)
    const sum = await foldAllRows<{ i: number }, number>(
      fetchPage, 0, (acc, page) => acc + page.length,
    )
    expect(sum).toBe(2_100)
  })

  it('is called once per page, not once per row', async () => {
    const { fetchPage } = pagedSource(2_100)
    const reducePage = vi.fn((acc: number, page: { i: number }[]) => acc + page.length)
    await foldAllRows<{ i: number }, number>(fetchPage, 0, reducePage)
    expect(reducePage).toHaveBeenCalledTimes(3)
  })

  it('keeps only ONE page live at a time — the accumulator is the caller\'s, not ours', async () => {
    // The whole point. A digest that counts rows per org should cost the size
    // of the tenant list, not the size of the scan; fetchAllRows charged it the
    // scan. Asserted by watching the page handed to the reducer: it never
    // exceeds one page, no matter how many pages there are.
    const { fetchPage } = pagedSource(5_000)
    const pageSizes: number[] = []
    const perOrg = await foldAllRows<{ i: number }, Map<string, number>>(
      fetchPage,
      new Map(),
      (acc, page) => {
        pageSizes.push(page.length)
        for (const row of page) {
          const org = `org_${row.i % 3}`
          acc.set(org, (acc.get(org) ?? 0) + 1)
        }
        return acc
      },
    )

    expect(Math.max(...pageSizes)).toBeLessThanOrEqual(SUPABASE_MAX_ROWS)
    expect(perOrg.size).toBe(3)
    expect([...perOrg.values()].reduce((a, b) => a + b, 0)).toBe(5_000)
  })

  it('does NOT inherit fetchAllRows\' 200k ceiling', async () => {
    // That ceiling is a MEMORY bound — it exists because fetchAllRows holds
    // every row. A fold holds one page, so capping it at the same number would
    // be an arbitrary limit on a scan that costs nothing to continue.
    const { fetchPage } = pagedSource(201_000)
    const seen = await foldAllRows<{ i: number }, number>(fetchPage, 0, (acc, page) => acc + page.length)
    expect(seen).toBe(201_000)
  })

  it('still throws on a query error', async () => {
    const fetchPage = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))
    await expect(foldAllRows(fetchPage, 0, (a: number) => a, { label: 'widgets' }))
      .rejects.toThrow(/Paginated fetch failed \(widgets\)/)
  })

  it('throws on runaway pagination rather than looping forever', async () => {
    // A query whose ordering is unstable can return a full page indefinitely.
    const fetchPage = vi.fn(async () => ({
      data: Array.from({ length: SUPABASE_MAX_ROWS }, (_, i) => ({ i })),
      error: null,
    }))
    await expect(foldAllRows(fetchPage, 0, (acc: number, page: unknown[]) => acc + page.length,
      { maxRows: 3_000, label: 'widgets' })).rejects.toThrow(/not converging/)
  })

  it('treats a null data page as empty rather than throwing', async () => {
    const fetchPage = vi.fn(async () => ({ data: null, error: null }))
    expect(await foldAllRows(fetchPage, 0, (acc: number, page: unknown[]) => acc + page.length)).toBe(0)
  })
})
