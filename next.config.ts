import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: '/crew/accept-invite/:token',
        destination: '/crew-invite/:token',
        permanent: false,
      },
    ]
  },

  async headers() {
    // Turbopack's dev-mode hydration relies on inline <script> tags and
    // eval()-based module wrapping — a strict script-src blocks React from
    // ever mounting under `next dev` (self.__next_r invariant, page never
    // hydrates).
    const isDev = process.env.NODE_ENV !== 'production'

    return [
      {
        // Apply these headers to all routes in the application
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              // Locked-down default — no blanket https: source
              "default-src 'self'",

              // TEMPORARY: 'unsafe-inline' restored in production —
              // Next.js App Router emits inline <script>self.__next_f.push()
              // </script> tags in production (not just dev/Turbopack) to
              // stream the RSC/hydration payload. Without 'unsafe-inline'
              // those are CSP-blocked, so the client never receives the data
              // needed to hydrate or resolve a Suspense boundary — this was
              // breaking hydration app-wide, not just on any one page.
              // 'unsafe-eval' stays dev-only (Turbopack HMR/eval-based module
              // wrapping). Follow-up: replace this with a per-request nonce
              // generated in proxy.ts so we don't need a blanket 'unsafe-inline'.
              isDev
                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
                : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",

              // Styles: 'unsafe-inline' required for the codebase's established
              // style={{ ... }} convention with CSS variables. Inline styles
              // are CSS, not JS — no code-execution XSS risk from this directive.
              "style-src 'self' 'unsafe-inline'",

              // Images: data: for base64, blob: for canvas/crop/file preview
              "img-src 'self' data: blob: https:",

              // Fonts: self + Google Fonts CDN if used
              "font-src 'self' data: https://fonts.gstatic.com",

              // Frames: Stripe hosted elements only
              "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",

              // Workers: blob: required for Supabase Realtime and some WASM usage
              "worker-src 'self' blob:",

              // API + WebSocket connections — preserved from previous config.
              // Sentry ingest host added for client-side error/trace reporting
              // (instrumentation-client.ts) — without this the browser SDK's
              // own requests get silently blocked by this same CSP.
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://js.stripe.com https://auth.hospitable.com https://public.api.hospitable.com https://o4511737962364928.ingest.us.sentry.io http://localhost:* ws://localhost:* wss://localhost:*",

              // Object/media: locked down entirely
              "object-src 'none'",
              "media-src 'self'",

              // Base URI: prevent base tag injection attacks
              "base-uri 'self'",

              // Form submissions: self only
              "form-action 'self'",
            ].join('; ')
          }
        ]
      }
    ]
  }
}

export default withSentryConfig(nextConfig, {
  org:     process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Unset in local dev — source maps are only uploaded when this is present,
  // so a missing authToken locally just skips the upload step rather than
  // failing the build. Required in CI/Vercel for symbolicated stack traces.
  authToken: process.env.SENTRY_AUTH_TOKEN,

  silent:               !process.env.CI,
  widenClientFileUpload: true,

  // No effect under Turbopack (this project's dev/build default) — kept for
  // when a webpack build is used (e.g. explicit `next build --no-turbopack`).
  webpack: {
    treeshake:              { removeDebugLogging: true },
    automaticVercelMonitors: true,
  },
})
