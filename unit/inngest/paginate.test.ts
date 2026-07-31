import { describe, it, expect, vi } from 'vitest'

import {
  fetchAllRows,
  fetchDistinctOrgIds,
  SUPABASE_MAX_ROWS,
  DEFAULT_PAGE_SIZE,
} from '@/lib/inngest/paginate'
import { createSupabaseDouble, asPage } from '../stubs/supabase-query-double'

/**
 * These tests exist because of a specific shipped bug: platform-wide cron
 * scans used an unbounded `.select()`, PostgREST silently capped the response
 * at max_rows (1000) with NO error and no truncation signal, and every tenant
 * past that line stopped being processed. Nothing failed — the crons just
 * quietly covered a shrinking fraction of the platform.
 *
 * So the fixture here is deliberately >1000 rows and the assertions are
 * "every seeded row came back", not "some rows came back". The shared query
 * double slices `.range(from, to)` against the seeded dataset for real
 * (see unit/stubs/supabase-query-double.ts), so a helper that only ever
 * requested page 0 — the exact bug — fails these outright.
 */

function seedRows(count: number, orgIds = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id:     `row_${String(i).padStart(6, '0')}`,
    org_id: `org_${i % orgIds}`,
  }))
}

describe('fetchAllRows', () => {
  it('drains every page of a >1000-row dataset instead of stopping at PostgREST max_rows', async () => {
    const total = 2_512   // 1000 + 1000 + 512 → three real pages
    const supabase = createSupabaseDouble({
      big_table: { data: seedRows(total), error: null },
    })

    const rows = await fetchAllRows<{ id: string }>(
      (from, to) => asPage<{ id: string }>(supabase
        .from('big_table')
        .select('id, org_id')
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to)),
      { label: 'big_table' },
    )

    expect(rows).toHaveLength(total)
    // Not just the count — the *tail* is what silent truncation eats.
    expect(rows[0]!.id).toBe('row_000000')
    expect(rows.at(-1)!.id).toBe(`row_${String(total - 1).padStart(6, '0')}`)
    expect(new Set(rows.map((r) => r.id)).size).toBe(total)

    // Three requests, each asking for a distinct 1000-row window.
    const rangeCalls = supabase.calls.filter((c) => c.method === 'range').map((c) => c.args)
    expect(rangeCalls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    expect(DEFAULT_PAGE_SIZE).toBe(SUPABASE_MAX_ROWS)
  })

  it('issues one extra empty-page request when the total is an exact multiple of the page size', async () => {
    const supabase = createSupabaseDouble({
      big_table: { data: seedRows(2_000), error: null },
    })

    const rows = await fetchAllRows<{ id: string }>(
      (from, to) => asPage<{ id: string }>(supabase.from('big_table').select('id').order('id').range(from, to)),
      { label: 'big_table' },
    )

    expect(rows).toHaveLength(2_000)
    // A full final page is indistinguishable from "there is more", so the
    // helper must probe once more rather than assume it is done.
    expect(supabase.calls.filter((c) => c.method === 'range')).toHaveLength(3)
  })

  it('THROWS at the maxRows ceiling rather than silently returning a truncated list', async () => {
    const supabase = createSupabaseDouble({
      big_table: { data: seedRows(5_000), error: null },
    })

    await expect(
      fetchAllRows<{ id: string }>(
        (from, to) => asPage<{ id: string }>(supabase.from('big_table').select('id').order('id').range(from, to)),
        { label: 'runaway_scan', maxRows: 2_000 },
      ),
    ).rejects.toThrow(/exceeded maxRows=2000 \(runaway_scan\)/)
  })

  it('respects a custom pageSize when slicing', async () => {
    const supabase = createSupabaseDouble({
      big_table: { data: seedRows(250), error: null },
    })

    const rows = await fetchAllRows<{ id: string }>(
      (from, to) => asPage<{ id: string }>(supabase.from('big_table').select('id').order('id').range(from, to)),
      { pageSize: 100 },
    )

    expect(rows).toHaveLength(250)
    expect(supabase.calls.filter((c) => c.method === 'range').map((c) => c.args)).toEqual([
      [0, 99], [100, 199], [200, 299],
    ])
  })

  it('throws with the query label when a page errors instead of returning a partial list', async () => {
    const fetchPage = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))

    await expect(fetchAllRows(fetchPage, { label: 'ical_feeds' })).rejects.toThrow(
      'Paginated fetch failed (ical_feeds): boom',
    )
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('treats a null data page as the end of the result set', async () => {
    const supabase = createSupabaseDouble({ empty_table: { data: null, error: null } })

    const rows = await fetchAllRows(
      (from, to) => asPage<{ id: string }>(supabase.from('empty_table').select('id').order('id').range(from, to)),
    )

    expect(rows).toEqual([])
    expect(supabase.calls.filter((c) => c.method === 'range')).toHaveLength(1)
  })
})

describe('fetchDistinctOrgIds', () => {
  it('de-duplicates org ids across every page of a >1000-row scan', async () => {
    // 2,400 rows spread over 40 orgs — every org appears in all three pages,
    // so a page-0-only read would still return 40 and look correct. The row
    // count assertion below is what actually catches truncation, so the
    // fixture also puts three orgs exclusively in the final page.
    const rows = [
      ...seedRows(2_400, 40),
      { id: 'row_tail_1', org_id: 'org_tail_a' },
      { id: 'row_tail_2', org_id: 'org_tail_b' },
      { id: 'row_tail_3', org_id: 'org_tail_c' },
    ]
    const supabase = createSupabaseDouble({ maintenance_schedules: { data: rows, error: null } })

    const orgIds = await fetchDistinctOrgIds(
      (from, to) => asPage<{ org_id: string }>(supabase
        .from('maintenance_schedules')
        .select('org_id')
        .eq('is_active', true)
        .order('org_id', { ascending: true })
        .range(from, to)),
      { label: 'maintenance_schedules.org_id' },
    )

    expect(orgIds).toHaveLength(43)
    // The tail orgs only exist past row 2,000 — they are exactly the tenants a
    // truncating scan drops on the floor.
    expect(orgIds).toContain('org_tail_a')
    expect(orgIds).toContain('org_tail_b')
    expect(orgIds).toContain('org_tail_c')
  })
})
