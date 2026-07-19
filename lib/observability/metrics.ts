import { reportError } from '@/lib/observability/report-error'

// Grafana Cloud OTLP push — see .env.example for how to obtain these.
// All three must be set or pushMetric() silently no-ops, same gating
// pattern as SMS_ENABLED in lib/sms/telnyx.ts.
function otlpConfig(): { endpoint: string; instanceId: string; token: string } | null {
  const endpoint   = process.env.GRAFANA_OTLP_ENDPOINT
  const instanceId = process.env.GRAFANA_OTLP_INSTANCE_ID
  const token      = process.env.GRAFANA_OTLP_TOKEN
  if (!endpoint || !instanceId || !token) return null
  return { endpoint, instanceId, token }
}

type Attributes = Record<string, string>

function toOtlpAttributes(attributes: Attributes) {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }))
}

async function pushMetric(metric: Record<string, unknown>): Promise<void> {
  const config = otlpConfig()
  if (!config) return

  const body = {
    resourceMetrics: [{
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'fieldstay' } }],
      },
      scopeMetrics: [{
        scope: { name: 'fieldstay.metrics' },
        metrics: [metric],
      }],
    }],
  }

  try {
    const res = await fetch(`${config.endpoint}/v1/metrics`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Basic ${Buffer.from(`${config.instanceId}:${config.token}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      reportError(new Error(`Grafana OTLP push failed: ${res.status} ${await res.text()}`), {
        site:  'observability.metrics.push',
        extra: { metric_name: String(metric.name ?? 'unknown') },
      })
    }
  } catch (err) {
    // Metrics must never break the caller's business logic — log to Sentry
    // and swallow, same as any other non-fatal side-channel send.
    reportError(err, {
      site:  'observability.metrics.push',
      extra: { metric_name: String(metric.name ?? 'unknown') },
    })
  }
}

/**
 * Increments a monotonic counter by `value` (default 1). Sent as an OTLP
 * delta sum data point — Grafana Cloud's OTLP ingestion converts delta
 * points to a cumulative series server-side, which is the correct shape
 * for stateless serverless callers that can't track a running total
 * themselves. `name` should follow Prometheus convention: snake_case,
 * `fieldstay_` prefix, `_total` suffix (e.g. 'fieldstay_turnovers_completed_total').
 */
export async function incrementCounter(
  name: string,
  attributes: Attributes = {},
  value = 1,
): Promise<void> {
  const nowNanos = `${Date.now()}000000`
  await pushMetric({
    name,
    unit: '1',
    sum: {
      dataPoints: [{
        startTimeUnixNano: nowNanos,
        timeUnixNano:      nowNanos,
        asInt:              String(value),
        attributes:         toOtlpAttributes(attributes),
      }],
      aggregationTemporality: 1, // DELTA
      isMonotonic:             true,
    },
  })
}

/**
 * Records a point-in-time value (e.g. a backlog count or below-par item
 * count). `name` should follow Prometheus convention: snake_case,
 * `fieldstay_` prefix, no `_total` suffix (e.g. 'fieldstay_work_orders_backlog').
 */
export async function recordGauge(
  name: string,
  value: number,
  attributes: Attributes = {},
): Promise<void> {
  const nowNanos = `${Date.now()}000000`
  await pushMetric({
    name,
    unit: '1',
    gauge: {
      dataPoints: [{
        timeUnixNano: nowNanos,
        asDouble:      value,
        attributes:    toOtlpAttributes(attributes),
      }],
    },
  })
}
