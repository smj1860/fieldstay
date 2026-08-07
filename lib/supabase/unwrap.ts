import type { PostgrestError } from '@supabase/supabase-js'
import { reportError } from '@/lib/observability/report-error'

// ============================================================================
// Deliberately NOT marked `import 'server-only'`, unlike most of lib/.
//
// Nothing in this file is a server capability: every export is a pure
// function over an already-resolved `{ data, error }` object, and its only
// two side effects — console.error and reportError() (@sentry/nextjs, which
// is isomorphic) — work identically in the browser. The marker was here by
// convention rather than because anything needed protecting, and it broke
// the build the moment the crew PWA's Dexie pull layer (lib/dexie/context.tsx,
// a Client Component that reads Supabase directly by design) needed to tell a
// failed read apart from an empty one. Same rationale as lib/storage/
// object-path.ts and lib/sms/template-registry.ts: client-safe by
// construction, so no marker.
//
// Distinguishing "the query errored" from "the query returned zero rows".
//
// The default destructure — the one that binds only `data` off a Supabase
// result and drops `error` on the floor — collapses both into a null `data`,
// so an RLS regression, a missing GRANT, or a
// transient network failure renders the same friendly "no vendors yet" empty
// state as a genuinely empty table — with nothing in the console and nothing
// in Sentry. That is exactly how the notification bell went dark in
// production without a single alert.
//
// Every read in this codebase should go through one of the helpers below.
// They log with real context, push the failure to Sentry via reportError(),
// and then either throw (so the segment's error.tsx renders a genuine error
// state, visibly distinct from empty) or hand the caller an explicit
// discriminated result it must branch on.
//
// See lib/observability/report-error.ts for the `site` naming convention.
// ============================================================================

export interface QueryContext {
  /** Dot-separated call-site id, e.g. 'page.vendors' or 'serverAction.turnovers.complete'. */
  site: string
  orgId?: string
  /** Non-PII identifiers only (record IDs, statuses, counts). Never emails, phones, or costs. */
  extra?: Record<string, string | number | boolean | null>
}

/**
 * Thrown by `unwrap*` when the underlying Postgrest call failed. Carries the
 * call site so a segment error boundary / Sentry issue is attributable, but
 * deliberately does NOT carry the raw Postgres message into the UI — the
 * detail is logged server-side only.
 */
export class SupabaseQueryError extends Error {
  readonly site: string
  readonly code: string | null

  constructor(site: string, code: string | null) {
    const codeSuffix = code ? ` (${code})` : ''
    super(`Supabase query failed at ${site}${codeSuffix}`)
    this.name = 'SupabaseQueryError'
    this.site = site
    this.code = code
  }
}

/** The shape every Supabase query (and `.rpc()`, and `.maybeSingle()`) resolves to. */
export interface PostgrestResult<T> {
  data: T | null
  error: PostgrestError | null
}

export interface CountResult {
  count: number | null
  error: PostgrestError | null
}

/** Result callers branch on when a failed read should degrade a section rather than the page. */
export type QueryOutcome<T> =
  | { ok: true;  data: T }
  | { ok: false; error: SupabaseQueryError }

/**
 * The subset of a Postgrest error the logger uses. Widened from PostgrestError
 * so the same guard covers Supabase Auth admin calls (AuthError), which carry
 * a message and a code but no details/hint.
 */
export interface QueryFailure {
  message:  string
  code?:    string | null
  details?: string | null
  hint?:    string | null
}

/**
 * True when `error` reflects an actual query failure rather than
 * `.single()`'s "no matching row" (PGRST116) — the latter is a legitimate,
 * often already-handled outcome (a fallback default, a skip) and must not be
 * conflated with an RLS/network failure that should abort the caller.
 */
export function isRealQueryError(error: QueryFailure | null | undefined): error is QueryFailure {
  return !!error && error.code !== 'PGRST116'
}

function record(error: QueryFailure, ctx: QueryContext): SupabaseQueryError {
  // Postgres error fields are diagnostic, never user data — safe to log.
  console.error(`[supabase:${ctx.site}]`, error.code ?? '', error.message, error.details ?? '')
  reportError(error, {
    site: ctx.site,
    orgId: ctx.orgId,
    extra: {
      ...ctx.extra,
      pg_code: error.code ?? null,
      pg_hint: error.hint ?? null,
    },
  })
  return new SupabaseQueryError(ctx.site, error.code ?? null)
}

/**
 * Unwraps a single-row read. Throws `SupabaseQueryError` when the query
 * itself failed; returns `null` only when the row genuinely does not exist.
 */
export function unwrap<T>(res: PostgrestResult<T>, ctx: QueryContext): T | null {
  if (res.error) throw record(res.error, ctx)
  return res.data
}

/**
 * Unwraps a list read to an always-defined array. Throws on query failure, so
 * an outage renders the segment's error.tsx instead of an empty list.
 */
export function unwrapList<T>(res: PostgrestResult<T[]>, ctx: QueryContext): T[] {
  if (res.error) throw record(res.error, ctx)
  return res.data ?? []
}

/** Unwraps a `{ count: 'exact', head: true }` read. Throws on query failure. */
export function unwrapCount(res: CountResult, ctx: QueryContext): number {
  if (res.error) throw record(res.error, ctx)
  return res.count ?? 0
}

/**
 * Non-throwing variant for reads whose failure should degrade one section
 * (a sidebar, a bell panel, an optional KPI) rather than the whole page.
 * Still logs and reports — the caller MUST render a distinct error state.
 */
export function tryUnwrap<T>(res: PostgrestResult<T>, ctx: QueryContext): QueryOutcome<T | null> {
  if (res.error) return { ok: false, error: record(res.error, ctx) }
  return { ok: true, data: res.data }
}

/** Non-throwing list variant. See `tryUnwrap`. */
export function tryUnwrapList<T>(res: PostgrestResult<T[]>, ctx: QueryContext): QueryOutcome<T[]> {
  if (res.error) return { ok: false, error: record(res.error, ctx) }
  return { ok: true, data: res.data ?? [] }
}

/**
 * Guard for a batch of parallel reads — the shape almost every list page uses:
 *
 *   const [{ data: a, error: aError }, { data: b, error: bError }] =
 *     await Promise.all([...])
 *   throwIfAnyQueryFailed({ site: 'page.turnovers', orgId }, aError, bError)
 *
 * Every failure is logged and reported (not just the first), then the batch
 * throws so the segment's error.tsx renders a real error state instead of the
 * page treating an outage as "you have nothing here yet".
 */
export function throwIfAnyQueryFailed(
  ctx: QueryContext,
  ...errors: (QueryFailure | null | undefined)[]
): void {
  let first: SupabaseQueryError | null = null
  for (const error of errors) {
    if (!error) continue
    const recorded = record(error, ctx)
    first ??= recorded
  }
  if (first) throw first
}

/**
 * Logs + reports a write/mutation error without throwing, so a Server Action
 * can return its own `{ success: false, error }` to the client. Returns true
 * when there was an error, so call sites read as a guard clause.
 */
export function reportQueryError(
  error: PostgrestError | null,
  ctx: QueryContext,
): error is PostgrestError {
  if (!error) return false
  record(error, ctx)
  return true
}
