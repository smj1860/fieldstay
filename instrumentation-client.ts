import * as Sentry from '@sentry/nextjs'

// Client bundles can only read NEXT_PUBLIC_ vars, so the browser rate has its
// own env var. Same policy as the server (see instrumentation.ts): 100% in
// preview/dev, 10% in production unless overridden. The presence check comes
// first because Number('') is 0, not NaN.
const parsedTracesSampleRate = Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE)
const tracesSampleRate =
  process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE && Number.isFinite(parsedTracesSampleRate)
    ? parsedTracesSampleRate
    : process.env.NEXT_PUBLIC_VERCEL_ENV === 'production' ? 0.1 : 1.0

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // NEXT_PUBLIC_VERCEL_ENV distinguishes production from preview deploys.
  // NODE_ENV alone reports every Vercel preview build as 'production', which
  // put preview noise in the same Sentry environment as real customer traffic.
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,

  tracesSampleRate,

  // See instrumentation.ts — never attach headers/cookies/IP automatically.
  // Matters more on the client, where the crew PWA and the public guest
  // guidebook both run in browsers we do not control.
  sendDefaultPii: false,

  // Browser console.error/warn become Sentry Logs, giving the crew PWA and the
  // guest guidebook a failure trail that previously existed only in a device
  // console nobody can read after the fact.
  enableLogs: true,
  integrations: [Sentry.consoleLoggingIntegration({ levels: ['error', 'warn'] })],
})

// Required for the SDK to instrument client-side route transitions
// (App Router navigations) as spans.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
