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

      // www → apex, 308.
      //
      // www.fieldstay.app was a live alias returning 200, not a redirect —
      // verified 2026-08-20. Every marketing page therefore existed at two
      // https URLs with identical content, and consolidation rested entirely
      // on the canonical tag. Google reported exactly that for the homepage:
      // "Alternate page with proper canonical tag — https://www.fieldstay.app/".
      // That status is benign, but a canonical tag is a HINT; a 308 is not.
      //
      // Scoped by host so it cannot touch app.fieldstay.app (the app origin,
      // where the session cookie lives) or fieldstay.app itself. The apex is
      // the canonical everywhere in this repo — see marketingUrl() in
      // lib/marketing.ts and app/sitemap.ts.
      //
      // Vercel's domain settings can do this at the edge without a function
      // invocation, which is marginally cheaper; this lives in the repo so the
      // behaviour is versioned and reviewable rather than a dashboard toggle
      // nobody can see in a diff.
      {
        source:      '/:path*',
        has:         [{ type: 'host', value: 'www.fieldstay.app' }],
        destination: 'https://fieldstay.app/:path*',
        permanent:   true,
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
