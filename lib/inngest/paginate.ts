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

/**
 * Default page size — deliberately one BELOW the PostgREST cap.
 *
 * The drain's only termination signal is `page.length < pageSize`. If pageSize
 * equalled max_rows, a server-side cap at or below it would clamp the very
 * first response, that short page would read as "no more rows", and the drain
 * would return a truncated set as though it were complete — silently, with a
 * 200 and no signal. That is bit-for-bit the failure this helper exists to
 * prevent, so the helper must not be able to cause it.
 *
 * At 999 a full page is provably unclamped: reaching pageSize means the server
 * did not truncate. The cost is one extra round trip per ~1M rows.
 * `unit/guardrails/pagination-page-size.test.ts` ties this to the max_rows in
 * supabase/config.toml so the two cannot drift apart.
 */
export const DEFAULT_PAGE_SIZE = SUPABASE_MAX_ROWS - 1

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
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const maxRows  = options.maxRows ?? 200_000
  const label    = options.label ?? 'query'

  const all: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1)
    if (error) throw new Error(`Paginated fetch failed (${label}): ${error.message}`)
    const page = data ?? []
    all.push(...page)
    if (page.length < pageSize) break
    if (all.length >= maxRows) {
      throw new Error(
        `Paginated fetch exceeded maxRows=${maxRows} (${label}) — this scan needs to be ` +
        `narrowed (a time window, a per-org fan-out) rather than paged further.`
      )
    }
  }
  return all
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
