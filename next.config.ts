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

  // Content-Security-Policy is set in proxy.ts, not here — it needs a fresh
  // nonce per request for script-src, which a static next.config.ts header
  // can't provide. Do not add a CSP header here: a second, nonce-less CSP
  // would make the browser enforce the intersection of both, silently
  // dropping the nonce and re-blocking Next.js's inline hydration scripts.
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
