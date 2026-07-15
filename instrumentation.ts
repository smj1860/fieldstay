import * as Sentry from '@sentry/nextjs'

// Sentry owns the OpenTelemetry tracer-provider registration for both
// traces and errors — this replaced an earlier @vercel/otel registerOTel()
// call here. Axiom's Inngest logger.* calls are unaffected: those ship via
// Vercel's own log capture, independent of this file's OTEL registration.
// The only thing this removes is Vercel's own native trace tab, which
// nothing else in this codebase reads from or depends on.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init({
      dsn:              process.env.NEXT_PUBLIC_SENTRY_DSN,
      environment:      process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      tracesSampleRate: 1.0,
    })
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init({
      dsn:              process.env.NEXT_PUBLIC_SENTRY_DSN,
      environment:      process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      tracesSampleRate: 1.0,
    })
  }
}

// Captures errors thrown during React Server Component rendering that
// escape error boundaries — Next.js's own instrumentation hook for this,
// wired directly to Sentry's handler.
export const onRequestError = Sentry.captureRequestError
