import * as Sentry from '@sentry/nextjs'

/**
 * Trace sampling: 100% is right for pre-launch and for preview/staging, where
 * volume is low and every trace is worth having. Production is driven by
 * SENTRY_TRACES_SAMPLE_RATE so the rate can be dialled from Vercel env vars
 * without a code deploy — raise it temporarily while investigating an
 * incident, then lower it again.
 *
 * An unset or unparseable value falls back to the environment default rather
 * than silently disabling tracing. The presence check comes first because
 * Number('') is 0, not NaN — without it an empty-but-defined var would parse
 * as a valid 0 and turn tracing off.
 */
function resolveTracesSampleRate(): number {
  const override = process.env.SENTRY_TRACES_SAMPLE_RATE
  if (override) {
    const parsed = Number(override)
    if (Number.isFinite(parsed)) return parsed
  }
  return process.env.VERCEL_ENV === 'production' ? 0.1 : 1.0
}

const tracesSampleRate = resolveTracesSampleRate()

/**
 * Next.js signals redirect() and notFound() by THROWING a control-flow error
 * that the framework catches upstream. Server Actions here wrap their bodies
 * in try/catch (see the reportError convention), so an ordinary
 * requireOrgMember() redirect to /login or /onboarding lands in the catch and
 * would be reported as an application error. Those are not failures — left
 * unfiltered they would be the single largest source of noise in this
 * project's Sentry, and alert fatigue makes every other signal worthless.
 */
function isNextControlFlow(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const digest = (err as { digest?: unknown }).digest
  return typeof digest === 'string' &&
    (digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND')
}

// Sentry owns the OpenTelemetry tracer-provider registration for both
// traces and errors — this replaced an earlier @vercel/otel registerOTel()
// call here. Axiom's Inngest logger.* calls are unaffected: those ship via
// Vercel's own log capture, independent of this file's OTEL registration.
// The only thing this removes is Vercel's own native trace tab, which
// nothing else in this codebase reads from or depends on.
export async function register() {
  const options = {
    dsn:         process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate,

    // Explicit rather than relying on the SDK default. This codebase treats
    // guest phone numbers, emails, SMS bodies and financial values as never
    // loggable (CLAUDE.md → Sensitive-data logging, enforced by
    // unit/guardrails/sensitive-data-logging.test.ts). sendDefaultPii would
    // attach request headers, cookies and IP addresses to every event and
    // quietly route around that rule.
    sendDefaultPii: false,

    // Forwards console.error/console.warn to Sentry Logs. The ~580 existing
    // console.error call sites are already vetted PII-free by the guardrail
    // above, so this captures the long tail that never had an explicit
    // reportError() call. Logs are a searchable backstop, NOT a replacement
    // for reportError(): only captureException produces a grouped, alertable
    // Issue carrying a `site` tag, which is why the catch-block sweep still
    // matters.
    enableLogs: true,

    integrations: [Sentry.consoleLoggingIntegration({ levels: ['error', 'warn'] })],

    beforeSend(event: Sentry.ErrorEvent, hint: Sentry.EventHint): Sentry.ErrorEvent | null {
      return isNextControlFlow(hint.originalException) ? null : event
    },
  }

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init(options)
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init(options)
  }
}

// Captures errors thrown during React Server Component rendering that
// escape error boundaries — Next.js's own instrumentation hook for this,
// wired directly to Sentry's handler.
export const onRequestError = Sentry.captureRequestError
