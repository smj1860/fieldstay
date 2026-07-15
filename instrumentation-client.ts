import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn:              process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment:      process.env.NODE_ENV,
  tracesSampleRate: 1.0,
})

// Required for the SDK to instrument client-side route transitions
// (App Router navigations) as spans.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
