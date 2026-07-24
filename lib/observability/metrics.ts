import * as Sentry from '@sentry/nextjs'

type Attributes = Record<string, string>

/**
 * Increments a counter by `value` (default 1) via Sentry's Application
 * Metrics (Sentry.metrics — supported since @sentry/nextjs v10.25.0, this
 * repo is on ^10.65.0). No credentials/setup beyond the existing DSN.
 * `name` should be snake_case with a `fieldstay_` prefix and `_total`
 * suffix (e.g. 'fieldstay_turnovers_completed_total').
 *
 * Explicitly flushed rather than left to the SDK's periodic buffer flush —
 * these calls run inside short-lived Inngest step invocations (a single
 * POST /api/inngest request/response cycle), which may end before a
 * buffered metric would otherwise be sent.
 */
export async function incrementCounter(
  name: string,
  attributes: Attributes = {},
  value = 1,
): Promise<void> {
  Sentry.metrics.count(name, value, { attributes })
  await Sentry.flush(2000)
}

/**
 * Records a point-in-time value (e.g. a backlog count or below-par item
 * count) via Sentry's Application Metrics. `name` should be snake_case
 * with a `fieldstay_` prefix, no `_total` suffix (e.g.
 * 'fieldstay_work_orders_backlog').
 */
export async function recordGauge(
  name: string,
  value: number,
  attributes: Attributes = {},
): Promise<void> {
  Sentry.metrics.gauge(name, value, { attributes })
  await Sentry.flush(2000)
}
