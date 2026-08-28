import * as Sentry from '@sentry/nextjs'

interface ReportErrorContext {
  // Dot-separated site identifier, e.g. 'turnovers.completeAction' or
  // 'inngest.work-order-dispatch'. Used as the Sentry 'site' tag so failures
  // are filterable by call site without relying on stack-trace grouping alone.
  site: string
  orgId?: string
  // Non-PII, non-financial identifiers only (record IDs, statuses, counts) —
  // never actual_cost, email, phone, or Stripe tokens. See CLAUDE.md
  // "Sensitive-data logging".
  extra?: Record<string, string | number | boolean | null>
  /**
   * Extra Sentry TAGS. Same sensitive-data rule as `extra` — plus a
   * cardinality one, because the difference between the two fields is not
   * cosmetic and picking wrong is a silent loss.
   *
   * `extra` is attached to the event and readable on its page, but it is NOT
   * indexed: it cannot be searched, filtered or aggregated in Discover, and a
   * query naming an `extra` key returns the events with the column blank —
   * which reads as "the value was not set" rather than "this field is not
   * queryable". The checkout plan/interval/price_id landed in `extra` first
   * and looked missing for exactly that reason.
   *
   * Tags ARE indexed, so use them for the low-cardinality dimensions you will
   * want to group by — an enum, a plan key, a provider name. Never for
   * something unbounded like a row id: Sentry caps distinct tag values, and a
   * high-cardinality tag degrades search for the whole project. Those belong
   * in `extra`.
   */
  tags?: Record<string, string>
}

/**
 * Build a readable message from something that is not an Error.
 *
 * `new Error(String(err))` produced the literal text "[object Object]" for
 * every plain object ever reported here — and the single biggest caller,
 * lib/supabase/unwrap.ts's record(), passes a PostgrestError, which is a plain
 * object. So every Supabase failure in the app arrived in Sentry titled
 * `Error: [object Object]`, with the Postgres message discarded at the one
 * point that was supposed to preserve it.
 *
 * That is not only unreadable, it breaks GROUPING: Sentry buckets on the
 * title, so unrelated failures from unrelated tables collapse together while
 * the same failure re-splits into new issues as stack frames shift. The
 * asset-health 23502 appeared as three separate issues (CUSHION-J, -K, -M)
 * for exactly this reason.
 *
 * Order matters: `message` first because that is the field PostgrestError,
 * fetch errors and most SDK error shapes actually carry.
 */
function describe(err: unknown): string {
  if (typeof err === 'string') return err
  if (typeof err !== 'object' || err === null) return String(err)

  const obj = err as Record<string, unknown>

  const parts: string[] = []
  if (typeof obj.message === 'string' && obj.message.length > 0) parts.push(obj.message)
  if (typeof obj.code === 'string' && obj.code.length > 0) parts.push(`(${obj.code})`)
  if (parts.length > 0) return parts.join(' ')

  // No message field — fall back to a JSON view rather than "[object Object]".
  // Bounded: an unexpected shape must not paste a huge blob into an issue
  // title, which would defeat grouping just as thoroughly.
  try {
    const json = JSON.stringify(err)
    if (json && json !== '{}') return json.length > 200 ? `${json.slice(0, 200)}…` : json
  } catch {
    // Circular or non-serialisable — fall through.
  }
  return String(err)
}

/**
 * Reports a caught error to Sentry in addition to whatever console.error()
 * call already logs it. Safe to call from Server Actions, Route Handlers,
 * and Inngest step catch blocks — never throws itself.
 */
export function reportError(err: unknown, context: ReportErrorContext): void {
  const error = err instanceof Error ? err : new Error(describe(err))

  // Preserve whatever the original object carried beyond its message, so a
  // Postgres `details`/`hint` is not lost just because it did not fit the
  // title. Callers that already set these in `extra` win.
  const original = typeof err === 'object' && err !== null && !(err instanceof Error)
    ? (err as Record<string, unknown>)
    : null

  Sentry.captureException(error, {
    tags: {
      // Caller tags first, so `site`/`org_id` cannot be overwritten by one —
      // those two are what every triage query filters on.
      ...(context.tags ?? {}),
      site: context.site,
      ...(context.orgId ? { org_id: context.orgId } : {}),
    },
    extra: {
      ...(original ? { original_error: describe(original) } : {}),
      ...context.extra,
    },
  })
}
