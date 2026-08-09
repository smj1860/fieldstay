/**
 * PostgREST caps every response at `max_rows` (supabase/config.toml:18 → 1000,
 * which is also the Supabase cloud default). An unbounded `.select()` that
 * matches more rows than the cap returns the first 1000 with NO error and no
 * truncation signal at all — so platform-wide cron scans silently stop
 * covering the platform the moment a tenant cohort pushes past that line.
 *
 * Every unbounded platform-wide read must therefore either paginate through
 * `.range()` (this helper) or be replaced by an aggregate that never ships
 * rows over the wire (`count: 'exact', head: true`, or an RPC).
 *
 * `unit/guardrails/unbounded-select.test.ts` enforces that mechanically.
 */

export const SUPABASE_MAX_ROWS = 1000

/** Default page size — matches the PostgREST cap, so one request per page. */
export const DEFAULT_PAGE_SIZE = SUPABASE_MAX_ROWS

export interface PaginateOptions {
  pageSize?: number
  /**
   * Hard ceiling on total rows accumulated. Reaching it throws rather than
   * silently truncating — the whole point of this helper is that truncation
   * is never invisible. Defaults to 200k, far above any realistic scan.
   */
  maxRows?: number
  /** Included in the error message so a blown ceiling names its query. */
  label?: string
}

type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/**
 * Drain a Supabase query across `.range()` pages until a short page arrives.
 *
 * ```ts
 * const feeds = await fetchAllRows<Feed>(
 *   (from, to) => supabase.from('ical_feeds').select('id, org_id').eq('is_active', true).range(from, to),
 *   { label: 'ical_feeds' },
 * )
 * ```
 *
 * The callback MUST apply a stable `.order(...)` when row identity across
 * pages matters; without one, PostgREST's page boundaries are not guaranteed
 * to be consistent under concurrent writes.
 */
export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  options: PaginateOptions = {}
): Promise<T[]> {
  const maxRows = options.maxRows ?? 200_000
  const label   = options.label ?? 'query'

  return foldAllRows<T, T[]>(
    fetchPage,
    [],
    (all, page) => {
      all.push(...page)
      return all
    },
    {
      ...options,
      maxRows,
      onCeiling: (seen) => {
        throw new Error(
          `Paginated fetch exceeded maxRows=${seen} (${label}) — this scan needs to be ` +
          `narrowed (a time window, a per-org fan-out) rather than paged further.`
        )
      },
    },
  )
}

/**
 * Ceiling for a FOLD, where memory does not scale with the row count.
 *
 * fetchAllRows' 200k ceiling exists because every row it reads is held in an
 * array until the caller is done with it — the ceiling IS the memory bound.
 * A fold keeps one page at a time, so the same number would be an arbitrary
 * cap on a scan that is not costing anything to continue. What remains worth
 * guarding is runaway pagination (a query whose ordering is unstable, a
 * filter that never narrows), which is orders of magnitude away from any real
 * scan.
 */
const FOLD_MAX_ROWS = 5_000_000

/**
 * Drain a paginated query one page at a time, folding each page into an
 * accumulator instead of materialising every row.
 *
 * Use this wherever the result is an AGGREGATE — a per-org count, a set of
 * ids, a max — rather than the rows themselves. `fetchAllRows(...)` followed
 * by a `for (const row of rows)` that only ever increments a counter holds the
 * entire platform-wide result set in memory to compute something the size of
 * the tenant list, and dies outright at the 200k ceiling rather than degrading.
 *
 * ```ts
 * const perOrg = await foldAllRows<Row, Map<string, number>>(
 *   (from, to) => supabase.from('work_orders').select('org_id').gte('created_at', since).order('id').range(from, to),
 *   new Map(),
 *   (counts, page) => { for (const r of page) counts.set(r.org_id, (counts.get(r.org_id) ?? 0) + 1); return counts },
 *   { label: 'work_orders(digest)' },
 * )
 * ```
 *
 * The callback MUST apply a stable `.order(...)` — same requirement, and same
 * reason, as fetchAllRows.
 */
export async function foldAllRows<T, A>(
  fetchPage:  (from: number, to: number) => PromiseLike<PageResult<T>>,
  initial:    A,
  reducePage: (acc: A, page: T[]) => A,
  options:    PaginateOptions & { onCeiling?: (seen: number) => never } = {},
): Promise<A> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const maxRows  = options.maxRows ?? FOLD_MAX_ROWS
  const label    = options.label ?? 'query'

  let acc  = initial
  let seen = 0

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1)
    if (error) throw new Error(`Paginated fetch failed (${label}): ${error.message}`)
    const page = data ?? []
    acc  = reducePage(acc, page)
    seen += page.length
    if (page.length < pageSize) break
    if (seen >= maxRows) {
      if (options.onCeiling) options.onCeiling(seen)
      throw new Error(
        `Paginated fold exceeded maxRows=${maxRows} (${label}) after ${seen} rows — the query is ` +
        `not converging (unstable ordering, or a filter that never narrows).`
      )
    }
  }

  return acc
}

/**
 * Distinct `org_id` values matching a query, for cron dispatchers that fan out
 * one event per tenant instead of processing every tenant's rows in a single
 * platform-wide invocation.
 */
export async function fetchDistinctOrgIds(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<{ org_id: string }>>,
  options: PaginateOptions = {}
): Promise<string[]> {
  const rows = await fetchAllRows(fetchPage, options)
  return Array.from(new Set(rows.map((r) => r.org_id)))
}
