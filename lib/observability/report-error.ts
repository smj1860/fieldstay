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
}

/**
 * Reports a caught error to Sentry in addition to whatever console.error()
 * call already logs it. Safe to call from Server Actions, Route Handlers,
 * and Inngest step catch blocks — never throws itself.
 */
export function reportError(err: unknown, context: ReportErrorContext): void {
  const error = err instanceof Error ? err : new Error(String(err))

  Sentry.captureException(error, {
    tags: {
      site: context.site,
      ...(context.orgId ? { org_id: context.orgId } : {}),
    },
    extra: context.extra,
  })
}
